"""
Common data models for Fluvio consumers
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field, validator


class TelemetryData(BaseModel):
    """Telemetry data from IoT devices"""
    device_id: str
    asset_id: int
    timestamp: datetime
    power: float = Field(ge=0)  # W
    energy: float = Field(ge=0)  # Wh
    voltage: float = Field(ge=0, le=1000)  # V
    current: float = Field(ge=0, le=1000)  # A
    frequency: float = Field(ge=45, le=65)  # Hz
    power_factor: float = Field(ge=0, le=1)
    battery_level: Optional[float] = Field(None, ge=0, le=100)  # %

    @validator('timestamp', pre=True)
    def parse_timestamp(cls, v):
        if isinstance(v, str):
            return datetime.fromisoformat(v.replace('Z', '+00:00'))
        return v


class DeviceStatus(BaseModel):
    """Device status message"""
    device_id: str
    status: str  # online, offline, error
    timestamp: datetime
    metadata: dict = {}


class SystemEvent(BaseModel):
    """System event message"""
    event_type: str
    user_id: Optional[int] = None
    device_id: Optional[str] = None
    data: dict
    timestamp: datetime
