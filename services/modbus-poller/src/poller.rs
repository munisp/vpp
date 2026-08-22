//! Device polling over Modbus TCP and RTU.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::time::timeout;
use tokio_modbus::client::{rtu, tcp, Context as ModbusContext, Reader};
use tokio_modbus::Slave;

use crate::config::{DeviceConfig, RegisterKind, Transport};
use crate::decode::decode;
use crate::platform::Reading;

/// Connects to a device. Connection failures are returned: a device that cannot
/// be reached has no readings, and inventing them would corrupt settlement.
pub async fn connect(device: &DeviceConfig, request_timeout: Duration) -> Result<ModbusContext> {
    match &device.transport {
        Transport::Tcp {
            host,
            port,
            unit_id,
        } => {
            let address = format!("{host}:{port}")
                .parse::<std::net::SocketAddr>()
                .or_else(|_| resolve(host, *port))
                .with_context(|| format!("resolving {host}:{port}"))?;
            let context = timeout(
                request_timeout,
                tcp::connect_slave(address, Slave(*unit_id)),
            )
            .await
            .map_err(|_| anyhow!("connecting to {address} timed out after {request_timeout:?}"))?
            .with_context(|| format!("connecting to {address}"))?;
            Ok(context)
        }
        Transport::Rtu {
            path,
            baud_rate,
            unit_id,
        } => {
            let builder = tokio_serial::new(path, *baud_rate).timeout(request_timeout);
            let port = tokio_serial::SerialStream::open(&builder)
                .with_context(|| format!("opening serial port {path}"))?;
            Ok(rtu::attach_slave(port, Slave(*unit_id)))
        }
    }
}

fn resolve(host: &str, port: u16) -> Result<std::net::SocketAddr> {
    use std::net::ToSocketAddrs;
    (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow!("{host} resolved to no addresses"))
}

/// Reads every configured register of a device.
///
/// Registers are read individually and a failed register is reported rather
/// than skipped silently, so a partially readable device cannot masquerade as a
/// healthy one.
pub async fn poll_device(
    context: &mut ModbusContext,
    device: &DeviceConfig,
    request_timeout: Duration,
    now_ms: i64,
) -> (Vec<Reading>, Vec<anyhow::Error>) {
    let mut readings = Vec::with_capacity(device.registers.len());
    let mut failures = Vec::new();

    for register in &device.registers {
        let count = register.data_type.word_count();
        let request = async {
            match register.kind {
                RegisterKind::Holding => {
                    context
                        .read_holding_registers(register.address, count)
                        .await
                }
                RegisterKind::Input => context.read_input_registers(register.address, count).await,
            }
        };

        let words = match timeout(request_timeout, request).await {
            Err(_) => {
                failures.push(anyhow!(
                    "reading {} of {} timed out after {:?}",
                    register.name,
                    device.id,
                    request_timeout
                ));
                continue;
            }
            Ok(Err(err)) => {
                failures.push(anyhow!("reading {} of {}: {err}", register.name, device.id));
                continue;
            }
            Ok(Ok(Err(exception))) => {
                failures.push(anyhow!(
                    "device {} returned Modbus exception for {}: {exception}",
                    device.id,
                    register.name
                ));
                continue;
            }
            Ok(Ok(Ok(words))) => words,
        };

        match decode(register, &words) {
            Ok(value) => readings.push(Reading {
                device_id: device.id.clone(),
                name: register.name.clone(),
                value,
                unit: register.unit.clone(),
                address: register.address,
                timestamp_ms: now_ms,
            }),
            Err(err) => failures.push(err),
        }
    }

    (readings, failures)
}

#[cfg(test)]
mod tests {
    use std::future;
    use std::net::SocketAddr;

    use tokio::net::TcpListener;
    use tokio_modbus::server::tcp::{accept_tcp_connection, Server};
    use tokio_modbus::{ExceptionCode, Request, Response};

    use super::*;
    use crate::config::{DataType, RegisterConfig, WordOrder};

    /// A Modbus TCP device that serves two input registers and rejects every
    /// other address, exactly as real hardware does.
    struct FakeDevice;

    impl tokio_modbus::server::Service for FakeDevice {
        type Request = Request<'static>;
        type Response = Response;
        type Exception = ExceptionCode;
        type Future = future::Ready<Result<Self::Response, Self::Exception>>;

        fn call(&self, request: Self::Request) -> Self::Future {
            future::ready(match request {
                // -5000 W as a big-endian signed 32-bit value.
                Request::ReadInputRegisters(40_083, 2) => {
                    Ok(Response::ReadInputRegisters(vec![0xFFFF, 0xEC78]))
                }
                Request::ReadHoldingRegisters(40_100, 1) => {
                    Ok(Response::ReadHoldingRegisters(vec![875]))
                }
                _ => Err(ExceptionCode::IllegalDataAddress),
            })
        }
    }

    async fn start_device() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let server = Server::new(listener);
            let _ = server
                .serve(
                    &|stream, socket| async move {
                        accept_tcp_connection(stream, socket, |_| Ok(Some(FakeDevice)))
                    },
                    |_err| {},
                )
                .await;
        });
        address
    }

    fn register(
        name: &str,
        address: u16,
        kind: RegisterKind,
        data_type: DataType,
        scale: f64,
    ) -> RegisterConfig {
        RegisterConfig {
            name: name.to_string(),
            address,
            kind,
            data_type,
            scale,
            unit: "W".to_string(),
            word_order: WordOrder::Big,
        }
    }

    fn device(address: SocketAddr, registers: Vec<RegisterConfig>) -> DeviceConfig {
        DeviceConfig {
            id: "inverter-1".to_string(),
            transport: Transport::Tcp {
                host: address.ip().to_string(),
                port: address.port(),
                unit_id: 1,
            },
            registers,
        }
    }

    #[tokio::test]
    async fn reads_real_registers_over_tcp() {
        let address = start_device().await;
        let device = device(
            address,
            vec![
                register(
                    "active_power_w",
                    40_083,
                    RegisterKind::Input,
                    DataType::I32,
                    1.0,
                ),
                register(
                    "soc_percent",
                    40_100,
                    RegisterKind::Holding,
                    DataType::U16,
                    0.1,
                ),
            ],
        );

        let mut context = connect(&device, Duration::from_secs(2))
            .await
            .expect("connect");
        let (readings, failures) = poll_device(
            &mut context,
            &device,
            Duration::from_secs(2),
            1_700_000_000_000,
        )
        .await;

        assert!(failures.is_empty(), "unexpected failures: {failures:?}");
        assert_eq!(readings.len(), 2);
        assert_eq!(readings[0].value, -5_000.0);
        assert!((readings[1].value - 87.5).abs() < 1e-9);
        assert_eq!(readings[0].device_id, "inverter-1");
    }

    /// A Modbus exception must be surfaced, not turned into a reading. The
    /// remaining registers are still reported so a partial outage is visible.
    #[tokio::test]
    async fn modbus_exceptions_are_reported() {
        let address = start_device().await;
        let device = device(
            address,
            vec![
                register("unmapped", 1, RegisterKind::Input, DataType::U16, 1.0),
                register(
                    "soc_percent",
                    40_100,
                    RegisterKind::Holding,
                    DataType::U16,
                    0.1,
                ),
            ],
        );

        let mut context = connect(&device, Duration::from_secs(2))
            .await
            .expect("connect");
        let (readings, failures) = poll_device(
            &mut context,
            &device,
            Duration::from_secs(2),
            1_700_000_000_000,
        )
        .await;

        assert_eq!(failures.len(), 1, "expected the unmapped register to fail");
        assert_eq!(readings.len(), 1);
        assert_eq!(readings[0].name, "soc_percent");
    }

    #[tokio::test]
    async fn unreachable_device_is_an_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        drop(listener);

        let device = device(
            address,
            vec![register(
                "active_power_w",
                40_083,
                RegisterKind::Input,
                DataType::I32,
                1.0,
            )],
        );
        assert!(connect(&device, Duration::from_millis(500)).await.is_err());
    }
}
