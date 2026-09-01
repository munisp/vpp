/**
 * VPP Platform Database Seeding Script (full-fleet edition)
 *
 * Populates EVERY public table (169) with realistic, referentially-consistent
 * demo data for the Nigerian private-utility prospect demo:
 *   - Ikeja Packaging Industries: 8MW captive gas plant (2x4MW) + 2MWh ESS + 500kW PV
 *   - Lekki Pearl Estate: residential distribution with rooftop solar + batteries
 *   - Kano Frontier Textiles: 7MW franchise area (turbine + community solar + feeders)
 *   - Tanzania presence: Arusha / Dar es Salaam prosumers (TZS, mpesa rails)
 *
 * Properties:
 *   - Idempotent: truncates all public tables (RESTART IDENTITY CASCADE) first,
 *     inside one transaction; re-running never duplicates.
 *   - Deterministic: seeded PRNG (mulberry32(42)); no Math.random chaos.
 *   - Fail loud: any failed insert aborts with the table name + driver error.
 *
 * Run with: DATABASE_URL='postgres://postgres@/postgres?host=/tmp/pgdb' npx tsx scripts/seed-database.ts
 */

// All timestamp columns are `timestamp without time zone` holding UTC; force
// the pg driver's Date serialization to UTC regardless of host TZ.
process.env.TZ = 'UTC';

import pg from 'pg';
const { Client } = pg;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres@/postgres?host=/tmp/pgdb';

const client = new Client({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — stable across reruns
// ---------------------------------------------------------------------------
let _seed = 42;
function rnd(): number {
  _seed |= 0;
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

// ---------------------------------------------------------------------------
// Time helpers (everything is UTC, timestamp-without-time-zone)
// ---------------------------------------------------------------------------
const NOW = Date.now();
const H = 3600_000;
const D = 24 * H;
/** Date `hours` before now */
const ago = (hours: number) => new Date(NOW - hours * H);
/** Date `hours` after now */
const ahead = (hours: number) => new Date(NOW + hours * H);
const dayStartHoursAgo = (days: number) => {
  const d = new Date(NOW - days * D);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const hex = (n: number) => {
  // deterministic pseudo-hex digest of length n
  let s = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < n; i++) s += chars[Math.floor(rnd() * 16)];
  return s;
};
const J = JSON.stringify;

// ---------------------------------------------------------------------------
// Insert helpers with fail-loud semantics
// ---------------------------------------------------------------------------
const counts: Record<string, number> = {};

async function insertRows(table: string, rows: any[], returningId = false): Promise<number[]> {
  if (!rows.length) return [];
  // Group rows by their exact key signature so omitted columns take DB defaults
  // (explicit nulls are honoured as NULL).
  const groups = new Map<string, { cols: string[]; idxs: number[] }>();
  rows.forEach((r, i) => {
    const cols = Object.keys(r).sort();
    const sig = cols.join('');
    const g = groups.get(sig) || { cols, idxs: [] };
    g.idxs.push(i);
    groups.set(sig, g);
  });
  const ids: number[] = new Array(rows.length);
  for (const g of groups.values()) {
    const gIds = await insertUniform(table, g.cols, g.idxs.map((i) => rows[i]), returningId);
    if (returningId) gIds.forEach((id, j) => (ids[g.idxs[j]] = id));
  }
  return ids;
}

async function insertUniform(table: string, cols: string[], rows: any[], returningId: boolean): Promise<number[]> {
  const ids: number[] = [];
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const vals: any[] = [];
    const ph = chunk.map((r, rI) => {
      const parts = cols.map((c, cI) => {
        vals.push(r[c] === undefined ? null : r[c]);
        return `$${rI * cols.length + cI + 1}`;
      });
      return `(${parts.join(',')})`;
    });
    const sqlText = `INSERT INTO "${table}" (${cols
      .map((c) => `"${c}"`)
      .join(',')}) VALUES ${ph.join(',')}${returningId ? ' RETURNING id' : ''}`;
    try {
      const res = await client.query(sqlText, vals);
      if (returningId) for (const row of res.rows) ids.push(row.id);
    } catch (e: any) {
      console.error(`\n❌ INSERT failed on table "${table}" (chunk starting at row ${i}):`);
      console.error(`   ${e.message}`);
      if (e.detail) console.error(`   detail: ${e.detail}`);
      if (e.constraint) console.error(`   constraint: ${e.constraint}`);
      throw e;
    }
    counts[table] = (counts[table] || 0) + chunk.length;
  }
  return ids;
}

const ins = (table: string, rows: any[]) => insertRows(table, rows, false);
const insRet = (table: string, rows: any[]) => insertRows(table, rows, true);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function seed() {
  const t0 = Date.now();
  console.log('🌱 VPP full-database seeding starting...');
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query('BEGIN');
  try {
    // -- 0. Idempotency: wipe every public table --------------------------
    const tbs = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
      )
    ).rows.map((r: any) => r.tablename);
    console.log(`🧹 Truncating ${tbs.length} tables...`);
    await client.query(
      `TRUNCATE ${tbs.map((t: string) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
    );

    // -- 1. users ----------------------------------------------------------
    console.log('👥 users');
    const ngPhone = (n: number) => `+23480${String(30000000 + n * 111111).slice(0, 8)}`;
    const tzPhone = (n: number) => `+2557${String(12000000 + n * 131313).slice(0, 8)}`;
    const personDefs: Array<[string, string]> = [
      ['Chiamaka Nwosu', 'nigeria'], ['Emeka Obi', 'nigeria'], ['Funke Alabi', 'nigeria'],
      ['Ibrahim Musa', 'nigeria'], ['Ngozi Eze', 'nigeria'], ['Olumide Ajayi', 'nigeria'],
      ['Halima Abdullahi', 'nigeria'], ['Chinedu Okafor', 'nigeria'], ['Yetunde Balogun', 'nigeria'],
      ['Segun Adeleke', 'nigeria'], ['Aisha Bello', 'nigeria'], ['Obinna Kalu', 'nigeria'],
      ['Titilayo Ogunleye', 'nigeria'], ['Musa Danjuma', 'nigeria'], ['Kelechi Iheanacho', 'nigeria'],
      ['Fadeke Ojo', 'nigeria'], ['Uche Madu', 'nigeria'], ['Rotimi Fashola', 'nigeria'],
      ['Zainab Lawal', 'nigeria'], ['Nnamdi Ebele', 'nigeria'], ['Osaze Osas', 'nigeria'],
      ['Juma Mwangi', 'tanzania'], ['Neema Mtui', 'tanzania'],
      ['Baraka Mushi', 'tanzania'], ['Zawadi Kessy', 'tanzania'],
    ];
    const userRows: any[] = [
      { openId: 'seed-admin-adaeze', name: 'Adaeze Okonkwo', email: 'adaeze.okonkwo@vpp-energy.ng', phone: ngPhone(1), loginMethod: 'email', role: 'admin', country: 'nigeria', currency: 'NGN', language: 'en', onboardingCompleted: true, onboardingStep: 5, consent_given: true, consent_at: ago(400 * 24), createdAt: ago(400 * 24) },
      { openId: 'seed-admin-babatunde', name: 'Babatunde Adeyemi', email: 'babatunde.adeyemi@vpp-energy.ng', phone: ngPhone(2), loginMethod: 'email', role: 'admin', country: 'nigeria', currency: 'NGN', language: 'yo', onboardingCompleted: true, onboardingStep: 5, consent_given: true, consent_at: ago(390 * 24), createdAt: ago(390 * 24) },
      { openId: 'seed-biz-ikeja-pack', name: 'Chukwuma Ezeani', email: 'operations@ikejapackaging.ng', phone: ngPhone(3), loginMethod: 'email', role: 'user', country: 'nigeria', currency: 'NGN', language: 'ig', participantType: 'business', businessLegalName: 'Ikeja Packaging Industries Ltd', businessRegistrationNumber: 'RC1745231', businessVerifiedAt: ago(300 * 24), businessVerifiedBy: 1, onboardingCompleted: true, onboardingStep: 5, consent_given: true, consent_at: ago(300 * 24), createdAt: ago(300 * 24) },
      { openId: 'seed-biz-lekki-estate', name: 'Morenike Davies', email: 'facility@lekkipearl.estate', phone: ngPhone(4), loginMethod: 'email', role: 'user', country: 'nigeria', currency: 'NGN', language: 'yo', participantType: 'business', businessLegalName: 'Lekki Pearl Estate Management Ltd', businessRegistrationNumber: 'RC1880455', businessVerifiedAt: ago(280 * 24), businessVerifiedBy: 1, onboardingCompleted: true, onboardingStep: 5, consent_given: true, consent_at: ago(280 * 24), createdAt: ago(280 * 24) },
      { openId: 'seed-biz-kano-textiles', name: 'Alhaji Sani Getso', email: 'energy@kanofrontier.ng', phone: ngPhone(5), loginMethod: 'email', role: 'user', country: 'nigeria', currency: 'NGN', language: 'ha', participantType: 'business', businessLegalName: 'Kano Frontier Textiles Ltd', businessRegistrationNumber: 'RC0991823', businessVerifiedAt: ago(260 * 24), businessVerifiedBy: 2, onboardingCompleted: true, onboardingStep: 5, consent_given: true, consent_at: ago(260 * 24), createdAt: ago(260 * 24) },
    ];
    personDefs.forEach(([name, country], i) => {
      const tz = country === 'tanzania';
      const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
      userRows.push({
        openId: `seed-user-${String(i + 1).padStart(3, '0')}`,
        name,
        email: `${slug}@${tz ? 'example.co.tz' : 'example.ng'}`,
        phone: tz ? tzPhone(i + 1) : ngPhone(i + 6),
        loginMethod: 'email',
        role: 'user',
        country,
        currency: tz ? 'TZS' : 'NGN',
        language: tz ? (i % 2 === 0 ? 'sw' : 'en') : pick(['en', 'en', 'en', 'ha', 'yo', 'ig']),
        timezone: tz ? 'Africa/Dar_es_Salaam' : 'Africa/Lagos',
        onboardingCompleted: true,
        onboardingStep: 5,
        consent_given: true,
        consent_at: ago(ri(30, 240) * 24),
        createdAt: ago(ri(30, 240) * 24),
      });
    });
    const userIds = await insRet('users', userRows);
    const U = (i: number) => userIds[i];
    const ADMIN = U(0); // Adaeze
    const OPS = U(1); // Babatunde
    const BIZ_IKEJA = U(2);
    const BIZ_LEKKI = U(3);
    const BIZ_KANO = U(4);
    const ESTATE_USERS = [U(5), U(6), U(7), U(8), U(9)];
    const NG_PEOPLE = userIds.slice(5, 26);
    const TZ_USERS = userIds.slice(26, 30);

    // -- 2. assets ---------------------------------------------------------
    console.log('⚡ assets');
    const mkMeta = (o: any) => J(o);
    const assetRows: any[] = [
      // Ikeja Packaging — 8MW captive gas plant + ESS + rooftop PV
      { userId: BIZ_IKEJA, assetType: 'generator', name: 'Captive Gas Gen 1 — CAT G3520', capacity: 4_000_000, make: 'Caterpillar', model: 'G3520H', serialNumber: 'CAT-G3520-NG-0001', installationDate: ago(500 * 24), status: 'active', approvalStatus: 'approved', metadata: mkMeta({ fuel: 'natural_gas', site: 'Ikeja Packaging, Oba Akran Ave', takeOrPayContract: 'TOP-2025-014' }) },
      { userId: BIZ_IKEJA, assetType: 'generator', name: 'Captive Gas Gen 2 — CAT G3520', capacity: 4_000_000, make: 'Caterpillar', model: 'G3520H', serialNumber: 'CAT-G3520-NG-0002', installationDate: ago(500 * 24), status: 'active', approvalStatus: 'approved', metadata: mkMeta({ fuel: 'natural_gas', site: 'Ikeja Packaging, Oba Akran Ave', takeOrPayContract: 'TOP-2025-014' }) },
      { userId: BIZ_IKEJA, assetType: 'battery', name: 'Industrial ESS — 2MWh LFP', capacity: 2_000_000, make: 'BYD', model: 'Cube Pro', serialNumber: 'BYD-CUBE-NG-0007', installationDate: ago(310 * 24), status: 'active', approvalStatus: 'approved', metadata: mkMeta({ currentSoc: 6400, maxChargeW: 600000, maxDischargeW: 800000 }) },
      { userId: BIZ_IKEJA, assetType: 'solar', name: 'Factory Rooftop PV — 500kWp', capacity: 500_000, make: 'Jinko', model: 'Tiger Neo 78', serialNumber: 'JKM500-NG-0011', installationDate: ago(290 * 24), status: 'active', approvalStatus: 'approved' },
      { userId: BIZ_IKEJA, assetType: 'meter', name: 'Main Incomer Meter — Ikeja', capacity: 10_000, make: 'Hexing', model: 'HXE310', serialNumber: 'HX-NG-100200', installationDate: ago(500 * 24), status: 'active', approvalStatus: 'approved' },
    ];
    // Lekki Pearl Estate homes (users 5..9)
    const estateSpecs = [
      { solar: 9_600, batt: 13_500, mk: 'Huawei', batMk: 'Huawei LUNA2000' },
      { solar: 7_200, batt: 13_500, mk: 'Jinko', batMk: 'Tesla Powerwall 2' },
      { solar: 12_000, batt: 20_000, mk: 'Longi', batMk: 'BYD Battery-Box' },
      { solar: 5_000, batt: 10_000, mk: 'JA Solar', batMk: 'Pylontech US3000C' },
      { solar: 8_000, batt: 13_500, mk: 'Trina', batMk: 'Tesla Powerwall 2' },
    ];
    estateSpecs.forEach((s, k) => {
      const u = ESTATE_USERS[k];
      assetRows.push(
        { userId: u, assetType: 'solar', name: `Rooftop PV — Lekki Pearl Villa ${k + 1}`, capacity: s.solar, make: s.mk, model: 'Residential 580W', serialNumber: `PV-LKJ-${100 + k}`, installationDate: ago(ri(120, 260) * 24), status: 'active', approvalStatus: 'approved' },
        { userId: u, assetType: 'battery', name: `Home Battery — Villa ${k + 1}`, capacity: s.batt, make: s.batMk, model: 'Residential ESS', serialNumber: `BAT-LKJ-${200 + k}`, installationDate: ago(ri(120, 260) * 24), status: k === 3 ? 'maintenance' : 'active', approvalStatus: 'approved', metadata: mkMeta({ currentSoc: ri(35, 88) * 100 }) },
        { userId: u, assetType: 'meter', name: `Prepaid Meter — Villa ${k + 1}`, capacity: 15_000, make: 'Mojec', model: 'MB2', serialNumber: `0424-LKJ-${3000 + k}`, installationDate: ago(ri(120, 260) * 24), status: 'active', approvalStatus: 'approved' },
      );
    });
    // Kano franchise area (7MW)
    assetRows.push(
      { userId: BIZ_KANO, assetType: 'generator', name: 'Franchise Gas Turbine — 7MW', capacity: 7_000_000, make: 'Solar Turbines', model: 'Taurus 70', serialNumber: 'ST-T70-NG-0021', installationDate: ago(620 * 24), status: 'active', approvalStatus: 'approved', metadata: mkMeta({ fuel: 'natural_gas', franchiseArea: 'Kano Frontier 7MW' }) },
      { userId: BIZ_KANO, assetType: 'solar', name: 'Community Solar — 1MWp', capacity: 1_000_000, make: 'Jinko', model: 'Tiger Neo Utility', serialNumber: 'JKM1M-NG-0040', installationDate: ago(200 * 24), status: 'active', approvalStatus: 'approved' },
      { userId: BIZ_KANO, assetType: 'meter', name: 'Feeder F1 Meter — Industrial Estate', capacity: 20_000, make: 'Hexing', model: 'HXE310', serialNumber: 'HX-KN-F1-001', installationDate: ago(600 * 24), status: 'active', approvalStatus: 'approved' },
      { userId: BIZ_KANO, assetType: 'meter', name: 'Feeder F2 Meter — Residential', capacity: 20_000, make: 'Hexing', model: 'HXE310', serialNumber: 'HX-KN-F2-002', installationDate: ago(600 * 24), status: 'active', approvalStatus: 'approved' },
    );
    // Tanzania prosumers
    const tzSpecs: Array<[number, number, number | null]> = [
      [26, 6_000, 10_000],
      [27, 4_500, 8_000],
      [28, 0, null], // small wind instead
      [29, 5_500, null],
    ];
    tzSpecs.forEach(([uIdx, pv, batt]) => {
      const u = U(uIdx);
      if (pv > 0)
        assetRows.push({ userId: u, assetType: 'solar', name: `Rooftop PV — Arusha ${uIdx}`, capacity: pv, make: 'JA Solar', model: 'JAM72S30', serialNumber: `PV-ARS-${uIdx}`, installationDate: ago(ri(90, 300) * 24), status: 'active', approvalStatus: 'approved' });
      if (batt)
        assetRows.push({ userId: u, assetType: 'battery', name: `Home Battery — Arusha ${uIdx}`, capacity: batt, make: 'Pylontech', model: 'US5000', serialNumber: `BAT-ARS-${uIdx}`, installationDate: ago(ri(90, 300) * 24), status: 'active', approvalStatus: 'approved', metadata: mkMeta({ currentSoc: ri(40, 90) * 100 }) });
      assetRows.push({ userId: u, assetType: 'meter', name: `Meter — TZ ${uIdx}`, capacity: 10_000, make: 'Inhemeter', model: 'DDSY666', serialNumber: `MT-ARS-${uIdx}`, installationDate: ago(ri(90, 300) * 24), status: uIdx === 29 ? 'fault' : 'active', approvalStatus: 'approved' });
    });
    assetRows.push({ userId: U(28), assetType: 'wind', name: 'Small Wind — Arusha Ridge 3kW', capacity: 3_000, make: 'Primus', model: 'AIR 40', serialNumber: 'WD-ARS-028', installationDate: ago(180 * 24), status: 'active', approvalStatus: 'pending' });

    const assetIds = await insRet('assets', assetRows);
    const A = (i: number) => assetIds[i];
    // key assets
    const GEN1 = A(0), GEN2 = A(1), BATT_IND = A(2), PV_IND = A(3), METER_IND = A(4);
    const PV_E0 = A(5), BATT_E0 = A(6), METER_E0 = A(7);
    const TURBINE = A(20), COMM_SOLAR = A(21), F1_METER = A(22), F2_METER = A(23);
    const batteryAssets = [BATT_IND, A(6), A(9), A(12), A(15), A(18)];
    const solarAssets = [PV_IND, PV_E0, A(8), A(11), A(14), A(17), COMM_SOLAR, A(24), A(27), A(31)];
    const gensetAssets = [GEN1, GEN2, TURBINE];

    // -- 3. devices + device logs/commands --------------------------------
    console.log('📟 devices');
    const devTypeFor: Record<string, string> = { solar: 'inverter', battery: 'battery_controller', meter: 'smart_meter', generator: 'sensor', wind: 'inverter' };
    const deviceRows = assetRows.map((a, i) => ({
      assetId: A(i),
      deviceId: `SEED-DEV-${String(i + 1).padStart(4, '0')}`,
      deviceType: devTypeFor[a.assetType],
      manufacturer: a.make || 'Generic',
      model: a.model || 'IoT-Edge',
      firmwareVersion: pick(['2.4.1', '2.5.0', '3.0.2']),
      mqttClientId: `vpp-dev-${String(i + 1).padStart(4, '0')}`,
      mqttUsername: `dev_${String(i + 1).padStart(4, '0')}`,
      mqttPasswordHash: hex(64),
      status: i === 15 || i === 33 ? 'offline' : 'online',
      lastSeen: ago(ri(0, 2)),
      lastMessageAt: ago(ri(0, 1)),
      telemetryInterval: 5,
      enabled: true,
    }));
    const deviceIds = await insRet('devices', deviceRows);
    const deviceCommandRows: any[] = [];
    for (let i = 0; i < 8; i++) {
      deviceCommandRows.push({
        deviceId: deviceIds[i % deviceIds.length],
        command: pick(['set_power_limit', 'restart', 'set_soc_target', 'firmware_check']),
        payload: J({ value: ri(10, 90) }),
        status: pick(['acknowledged', 'acknowledged', 'sent', 'failed', 'pending']),
        sentAt: ago(ri(2, 72)),
        acknowledgedAt: ago(ri(1, 2)),
        response: J({ ok: true, tookMs: ri(40, 900) }),
      });
    }
    await ins('device_commands', deviceCommandRows);
    const deviceLogRows: any[] = [];
    for (let i = 0; i < 14; i++) {
      deviceLogRows.push({
        deviceId: deviceIds[i % deviceIds.length],
        eventType: pick(['connected', 'disconnected', 'info', 'warning', 'error']),
        message: pick(['MQTT session established', 'Keepalive timeout, reconnecting', 'Telemetry batch flushed', 'NTP drift corrected', 'Modbus read retry']),
        metadata: J({ rssi: -ri(40, 85) }),
      });
    }
    await ins('device_logs', deviceLogRows);

    // -- 4. telemetry (30 days, hourly, 7 key assets) ---------------------
    console.log('📊 telemetry (30 days hourly × 7 key assets)');
    const HOURS = 30 * 24;
    const solarCurve = (utcH: number) => {
      // Lagos daylight ≈ 05:00–19:00 UTC; sine bell peaking 12:00 UTC
      if (utcH <= 5 || utcH >= 19) return 0;
      return Math.sin((Math.PI * (utcH - 5)) / 14);
    };
    const telemRows: any[] = [];
    const t0ms = dayStartHoursAgo(30).getTime();
    for (let hi = 0; hi < HOURS; hi++) {
      const ts = new Date(t0ms + hi * H);
      const utcH = ts.getUTCHours();
      const cloud = 0.82 + rnd() * 0.18; // per-hour cloud jitter
      // GEN1 — industrial base load ~62% of 4MW, 24/7
      const genP = Math.round(4_000_000 * (0.60 + 0.04 * rnd()));
      telemRows.push({ assetId: GEN1, timestamp: ts, power: genP, energy: Math.round((genP * (hi + 1)) / 1) > 2_000_000_000 ? 2_000_000_000 : genP * (hi + 1), voltage: 11_000_000 + ri(-150_000, 150_000), current: Math.round((genP / 11_000) * 1000), frequency: 50_000 + ri(-45, 45), temperature: (78 + ri(0, 6)) * 100 });
      // Industrial battery — charge 10–15 UTC, discharge 17–21 UTC (matches dispatch)
      let bP = 0;
      if (utcH >= 10 && utcH <= 15) bP = -400_000 - ri(0, 30_000);
      else if (utcH >= 17 && utcH <= 21) bP = 650_000 + ri(0, 40_000);
      const dayIdx = Math.floor(hi / 24);
      const battSocBase = 5000 + Math.round(2400 * Math.sin(((utcH - 8) / 24) * 2 * Math.PI));
      telemRows.push({ assetId: BATT_IND, timestamp: ts, power: bP, energy: Math.abs(bP) * (dayIdx + 1), voltage: 780_000 + ri(-8_000, 8_000), current: Math.round((bP / 780) * 1000), frequency: 50_000 + ri(-30, 30), stateOfCharge: Math.min(9500, Math.max(2000, battSocBase)), temperature: (31 + ri(0, 4)) * 100 });
      // Industrial PV 500kW
      const pvInd = Math.round(500_000 * 0.78 * solarCurve(utcH) * cloud);
      telemRows.push({ assetId: PV_IND, timestamp: ts, power: pvInd, energy: pvInd * (dayIdx + 1), voltage: 230_000 + ri(-2_500, 2_500), current: Math.round((pvInd / 230) * 1000), frequency: 50_000 + ri(-35, 35), temperature: (26 + Math.round(9 * solarCurve(utcH))) * 100 });
      // Estate villa 1 solar 9.6kW
      const pvE = Math.round(9_600 * 0.8 * solarCurve(utcH) * cloud);
      telemRows.push({ assetId: PV_E0, timestamp: ts, power: pvE, energy: pvE * (dayIdx + 1), voltage: 231_000 + ri(-3_000, 3_000), current: Math.round((pvE / 231) * 1000), frequency: 50_000 + ri(-40, 40), temperature: (25 + Math.round(8 * solarCurve(utcH))) * 100 });
      // Estate villa 1 battery 13.5kWh — evening discharge, midday charge
      let ebP = 0;
      if (utcH >= 11 && utcH <= 14) ebP = -2_800;
      else if (utcH >= 18 && utcH <= 22) ebP = 3_400;
      const eSoc = 5200 + Math.round(3000 * Math.sin(((utcH - 9) / 24) * 2 * Math.PI));
      telemRows.push({ assetId: BATT_E0, timestamp: ts, power: ebP, energy: Math.abs(ebP) * (dayIdx + 1), voltage: 51_200 + ri(-600, 600), current: Math.round((ebP / 51.2) * 10), stateOfCharge: Math.min(9800, Math.max(1500, eSoc)), temperature: (29 + ri(0, 5)) * 100 });
      // Estate villa 1 meter — residential consumption curve
      const loadBase = 350 + (utcH >= 5 && utcH <= 8 ? 1_100 : 0) + (utcH >= 17 && utcH <= 22 ? 2_600 : 0);
      const mP = Math.round(loadBase * (0.85 + rnd() * 0.3));
      telemRows.push({ assetId: METER_E0, timestamp: ts, power: mP, energy: mP * (hi + 1), voltage: 229_000 + ri(-4_000, 4_000), current: Math.round((mP / 229) * 1000), frequency: 50_000 + ri(-45, 45) });
      // Franchise turbine — 7MW at ~58% continuous
      const tP = Math.round(7_000_000 * (0.55 + 0.05 * rnd()));
      telemRows.push({ assetId: TURBINE, timestamp: ts, power: tP, energy: Math.min(2_000_000_000, Math.round(tP / 2) * (hi + 1)), voltage: 11_000_000 + ri(-120_000, 120_000), current: Math.round((tP / 11_000) * 1000), frequency: 50_000 + ri(-50, 50), temperature: (540 + ri(0, 25)) * 100 });
    }
    await ins('telemetry', telemRows);

    // -- 5. grid_monitoring (hourly, 30 days) ------------------------------
    console.log('🗼 grid_monitoring');
    const gmRows: any[] = [];
    for (let hi = 0; hi < HOURS; hi++) {
      const ts = new Date(t0ms + hi * H);
      const utcH = ts.getUTCHours();
      const indLoad = Math.round(5_600 * (0.9 + rnd() * 0.2)); // kW industrial
      const resLoad = Math.round((utcH >= 17 && utcH <= 22 ? 2_400 : 900) * (0.85 + rnd() * 0.3));
      const totalLoad = indLoad + resLoad;
      const ren = Math.round(2_600 * solarCurve(utcH) * (0.8 + rnd() * 0.2));
      const totalGen = totalLoad + ri(50, 250);
      const spot = utcH <= 5 ? 4_200 : utcH <= 11 ? 8_500 : utcH <= 16 ? 12_500 : utcH <= 21 ? 21_000 : 8_500;
      gmRows.push({
        timestamp: ts,
        total_load: totalLoad,
        peak_load: totalLoad + ri(0, 400),
        average_load: Math.round(totalLoad * 0.92),
        total_generation: totalGen,
        renewable_generation: ren,
        renewable_percentage: Math.min(100, Math.round((ren / totalGen) * 100)),
        frequency: 4_990 + ri(0, 20),
        voltage: 11_000 + ri(-90, 90),
        grid_status: utcH >= 17 && utcH <= 21 && rnd() < 0.2 ? 'stressed' : 'normal',
        spot_price: spot,
        forecast_price: spot + ri(-300, 300),
      });
    }
    await ins('grid_monitoring', gmRows);

    // -- 6. marketPrices (hourly, 30 days, NG + TZ) ------------------------
    console.log('💹 marketPrices');
    const priceTypeForHour = (h: number) =>
      h <= 5 ? 'off_peak' : h <= 11 ? 'shoulder' : h <= 16 ? 'peak' : h <= 21 ? 'super_peak' : 'shoulder';
    const mpRows: any[] = [];
    for (let hi = 0; hi < HOURS; hi++) {
      const ts = new Date(t0ms + hi * H);
      const utcH = ts.getUTCHours();
      const pt = priceTypeForHour(utcH);
      const ngBase = pt === 'off_peak' ? 4_200 : pt === 'shoulder' ? 8_500 : pt === 'peak' ? 12_500 : 21_000;
      const tzBase = pt === 'off_peak' ? 9_800 : pt === 'shoulder' ? 15_600 : pt === 'peak' ? 24_000 : 38_000;
      mpRows.push(
        { country: 'nigeria', priceType: pt, price: ngBase + ri(-250, 250), timestamp: ts, validUntil: new Date(ts.getTime() + H), metadata: J({ region: 'NG-LAGOS', source: 'vpp-merit-order' }) },
        { country: 'tanzania', priceType: pt, price: tzBase + ri(-400, 400), timestamp: ts, validUntil: new Date(ts.getTime() + H), metadata: J({ region: 'TZ-ARUSHA', source: 'vpp-merit-order' }) },
      );
    }
    await ins('marketPrices', mpRows);

    // -- 7. dispatch schedules + setpoints (consistent with battery telemetry)
    console.log('📤 dispatch_schedules / dispatch_setpoints');
    const [schedY, schedT] = await insRet('dispatch_schedules', [
      { schedule_id: `DS-${dayStartHoursAgo(1).toISOString().slice(0, 10)}-LAGOS`, schedule_start: dayStartHoursAgo(1), schedule_end: dayStartHoursAgo(0), interval_minutes: 60, optimization_run_id: 'OPT-SEED-001', objective_function: 'maximize_revenue', status: 'completed', total_expected_revenue: 4_800_000, total_expected_cost: 1_100_000, total_expected_emissions_saved: 1_250 },
      { schedule_id: `DS-${dayStartHoursAgo(0).toISOString().slice(0, 10)}-LAGOS`, schedule_start: dayStartHoursAgo(0), schedule_end: ahead(24), interval_minutes: 60, optimization_run_id: 'OPT-SEED-002', objective_function: 'balance_grid', status: 'approved', total_expected_revenue: 3_900_000, total_expected_cost: 950_000 },
    ]);
    const spRows: any[] = [];
    for (let hI = 0; hI < 24; hI++) {
      const start = new Date(dayStartHoursAgo(1).getTime() + hI * H);
      const end = new Date(start.getTime() + H);
      let target = 0;
      if (hI >= 10 && hI <= 15) target = -400_000;
      else if (hI >= 17 && hI <= 21) target = 650_000;
      const actual = target === 0 ? 0 : Math.round(target * (0.97 + rnd() * 0.05));
      spRows.push({ schedule_id: schedY, asset_id: BATT_IND, interval_start: start, interval_end: end, target_power_watts: target, target_soc_percent: target < 0 ? 9000 : target > 0 ? 3000 : null, status: 'completed', actual_power_watts: actual, actual_soc_percent: null, dispatched_at: start, acknowledged_at: start, completed_at: end, deviation_watts: actual - target, performance_score: ri(92, 99) });
    }
    for (let hI = 0; hI < 12; hI++) {
      const start = new Date(dayStartHoursAgo(0).getTime() + hI * H);
      spRows.push({ schedule_id: schedT, asset_id: BATT_IND, interval_start: start, interval_end: new Date(start.getTime() + H), target_power_watts: hI >= 17 && hI <= 21 ? 600_000 : 0, status: 'scheduled' });
    }
    await ins('dispatch_setpoints', spRows);

    // -- 8. billings -------------------------------------------------------
    console.log('🧾 billings');
    const billingRows: any[] = [];
    const billingUsers = [BIZ_IKEJA, BIZ_LEKKI, BIZ_KANO, ...ESTATE_USERS, ...NG_PEOPLE.slice(5, 12)];
    billingUsers.forEach((u, i) => {
      const status = i % 5 === 0 ? 'paid' : i % 5 === 1 ? 'issued' : i % 5 === 2 ? 'overdue' : i % 5 === 3 ? 'paid' : 'draft';
      const consumption = u === BIZ_IKEJA ? 1_250_000 : u === BIZ_KANO ? 980_000 : ri(180, 950);
      const generation = ESTATE_USERS.includes(u) ? ri(200, 800) : 0;
      const exportKwh = ESTATE_USERS.includes(u) ? ri(40, 220) : 0;
      const exportRevenue = exportKwh * 6_500;
      const savings = generation * 9_000;
      const totalValue = exportRevenue + savings;
      billingRows.push({
        userId: u,
        billingType: 'postpaid',
        periodStart: dayStartHoursAgo(30),
        periodEnd: dayStartHoursAgo(0),
        generationKwh: generation,
        consumptionKwh: consumption,
        exportKwh,
        exportRevenue,
        selfConsumptionSavings: savings,
        totalValue,
        consumerShare: Math.round(totalValue * 0.7),
        vppCommission: Math.round(totalValue * 0.3),
        status,
        paidAt: status === 'paid' ? ago(ri(24, 200)) : null,
        paymentMethod: status === 'paid' ? pick(['paystack', 'flutterwave', 'bank_transfer']) : null,
        transactionId: status === 'paid' ? `TXN-BILL-${String(i + 1).padStart(4, '0')}` : null,
      });
    });
    const billingIds = await insRet('billings', billingRows);

    // -- 9. payments (mix incl. paystack/flutterwave) ----------------------
    console.log('💳 payments');
    const paymentRows: any[] = [];
    let txnSeq = 1;
    const mkPay = (o: any) => paymentRows.push(o);
    // 10 token purchases (NG rails)
    const ngRails = ['paystack', 'flutterwave', 'card', 'bank_transfer', 'paystack', 'flutterwave'];
    for (let i = 0; i < 10; i++) {
      const u = ESTATE_USERS[i % 5];
      mkPay({
        userId: u,
        paymentType: 'token_purchase',
        amount: ri(2, 40) * 250_000, // ₦5k–₦100k in kobo
        currency: 'NGN',
        paymentMethod: ngRails[i % ngRails.length],
        transactionId: `PSK-SEED-${String(txnSeq++).padStart(4, '0')}`,
        status: i === 8 ? 'failed' : i === 9 ? 'pending' : 'completed',
        createdAt: ago(ri(2, 29 * 24)),
        metadata: J({ meter: `0424-LKJ-${3000 + (i % 5)}` }),
      });
    }
    // 12 invoice payments linked to billings
    for (let i = 0; i < 12; i++) {
      const b = billingRows[i];
      mkPay({
        userId: b.userId,
        billingId: billingIds[i],
        paymentType: 'invoice',
        amount: Math.max(100_000, b.totalValue),
        currency: 'NGN',
        paymentMethod: pick(['paystack', 'flutterwave', 'bank_transfer', 'card']),
        transactionId: `PSK-SEED-${String(txnSeq++).padStart(4, '0')}`,
        status: b.status === 'paid' ? 'completed' : pick(['pending', 'failed']),
        createdAt: ago(ri(2, 29 * 24)),
      });
    }
    // 4 monthly fees
    for (let i = 0; i < 4; i++) {
      mkPay({
        userId: [BIZ_IKEJA, BIZ_LEKKI, BIZ_KANO, ESTATE_USERS[0]][i],
        paymentType: 'monthly_fee',
        amount: 1_500_000,
        currency: 'NGN',
        paymentMethod: pick(['paystack', 'bank_transfer']),
        transactionId: `PSK-SEED-${String(txnSeq++).padStart(4, '0')}`,
        status: 'completed',
        createdAt: ago(ri(48, 28 * 24)),
      });
    }
    // 4 TZ mobile-money payments
    for (let i = 0; i < 4; i++) {
      mkPay({
        userId: TZ_USERS[i],
        paymentType: 'token_purchase',
        amount: ri(5, 60) * 1_000_000,
        currency: 'TZS',
        paymentMethod: pick(['mpesa', 'tigo_pesa', 'airtel_money']),
        phoneNumber: tzPhone(i + 1),
        transactionId: `MPESA-SEED-${String(i + 1).padStart(4, '0')}`,
        status: i === 3 ? 'refunded' : 'completed',
        createdAt: ago(ri(2, 25 * 24)),
      });
    }
    const paymentIds = await insRet('payments', paymentRows);
    const completedTokenPayments = paymentIds.slice(0, 8); // first 8 token purchases are completed

    // -- 10. legacy tokens -------------------------------------------------
    console.log('🔑 tokens');
    const tokenRows: any[] = [];
    for (let i = 0; i < 12; i++) {
      const u = ESTATE_USERS[i % 5];
      const status = i % 4 === 0 ? 'used' : i % 4 === 1 ? 'active' : i % 4 === 2 ? 'expired' : 'pending_issuance';
      tokenRows.push({
        userId: u,
        paymentId: completedTokenPayments[i % completedTokenPayments.length],
        tokenCode: `${ri(1000, 9999)}-${ri(1000, 9999)}-${ri(1000, 9999)}-${ri(1000, 9999)}-${ri(1000, 9999)}`,
        energyKwh: ri(25, 400),
        amount: ri(2, 40) * 250_000,
        validUntil: status === 'expired' ? ago(24) : ahead(30 * 24),
        status,
        usedAt: status === 'used' ? ago(ri(2, 20 * 24)) : null,
      });
    }
    await ins('tokens', tokenRows);

    // -- 11. prepaid (openpaygo / STS) --------------------------------------
    console.log('⚡ prepaid_*');
    const prepaidAccountRows = ESTATE_USERS.map((u, k) => ({
      user_id: u,
      meter_asset_id: A(7 + 3 * k),
      meter_serial: `0424-LKJ-${3000 + k}`,
      scheme: k % 2 === 0 ? 'openpaygo' : 'sts_certified',
      device_profile: k % 2 === 0 ? 'OpenPayGO Token v2 / SparkMeter' : 'STS IEC 62055-41 Class 2',
      key_ref: `kms://vpp/meter-keys/0424-LKJ-${3000 + k}`,
      starting_code: 0,
      token_count: 6 + k,
      wh_per_value_unit: 1,
      tariff_minor_per_kwh: 12_500,
      currency: 'NGN',
      credited_wh: 320_000 + k * 45_000,
      consumed_wh: 210_000 + k * 30_000,
      meter_register_wh: 210_000 + k * 30_000,
      meter_reading_at: ago(ri(2, 20)),
      status: 'active',
      opened_at: ago(200 * 24),
      opened_by: ADMIN,
    }));
    prepaidAccountRows.push({
      user_id: BIZ_IKEJA,
      meter_asset_id: METER_IND,
      meter_serial: 'HX-NG-100200',
      scheme: 'sts_certified',
      device_profile: 'STS IEC 62055-41 Class 2',
      key_ref: 'kms://vpp/meter-keys/HX-NG-100200',
      starting_code: 0,
      token_count: 12,
      wh_per_value_unit: 1000,
      tariff_minor_per_kwh: 9_800,
      currency: 'NGN',
      credited_wh: 12_000_000,
      consumed_wh: 9_400_000,
      meter_register_wh: 9_400_000,
      meter_reading_at: ago(6),
      status: 'active',
      opened_at: ago(280 * 24),
      opened_by: OPS,
    });
    const prepaidAccountIds = await insRet('prepaid_accounts', prepaidAccountRows);

    const prepaidTokenRows: any[] = [];
    for (let i = 0; i < 10; i++) {
      const accIdx = i % 6;
      const status = i % 5 === 0 ? 'void' : i % 5 <= 2 ? 'redeemed' : 'issued';
      const energyWh = ri(20, 400) * 1000;
      prepaidTokenRows.push({
        account_id: prepaidAccountIds[accIdx],
        payment_id: completedTokenPayments[i % completedTokenPayments.length],
        sequence: 100 + i,
        scheme: prepaidAccountRows[accIdx].scheme,
        token_code: `${ri(1000, 9999)} ${ri(1000, 9999)} ${ri(1000, 9999)} ${ri(1000, 9999)} ${ri(1000, 9999)}`,
        token_count: 101 + i,
        token_type: 'electricity_credit',
        energy_wh: energyWh,
        value_units: prepaidAccountRows[accIdx].wh_per_value_unit === 1 ? energyWh : Math.round(energyWh / 1000),
        amount_minor: Math.round((energyWh / 1000) * prepaidAccountRows[accIdx].tariff_minor_per_kwh),
        currency: 'NGN',
        status,
        provider_reference: `OPG-SEED-${String(i + 1).padStart(5, '0')}`,
        issued_at: ago(ri(24, 28 * 24)),
        issued_by: ADMIN,
        redeemed_at: status === 'redeemed' ? ago(ri(2, 20 * 24)) : null,
        redemption_evidence_ref: status === 'redeemed' ? `meter-ack-${1000 + i}` : null,
        void_reason: status === 'void' ? 'Duplicate vend reversed by operator' : null,
      });
    }
    await ins('prepaid_tokens', prepaidTokenRows);

    const prepaidConsumptionRows: any[] = [];
    prepaidAccountIds.forEach((accId, k) => {
      const reg0 = 150_000 + k * 30_000;
      for (let w = 0; w < 2; w++) {
        const e = 28_000 + k * 2_000 + w * 3_000;
        prepaidConsumptionRows.push({
          account_id: accId,
          from_at: ago((14 - 7 * w) * 24),
          to_at: ago((7 - 7 * w) * 24),
          register_start_wh: reg0 + (w === 1 ? e : 0) - e,
          register_end_wh: reg0 + (w === 1 ? e : 0),
          energy_wh: e,
          source: 'meter_register',
          evidence_ref: `mread-${k}-${w}-${hex(8)}`,
          detail: 'Weekly register read via edge gateway',
        });
      }
    });
    await ins('prepaid_consumption', prepaidConsumptionRows);

    await ins('prepaid_supply_events', [
      { account_id: prepaidAccountIds[3], action: 'disconnect', reason: 'credit_exhausted', enforced_at_meter: true, evidence_ref: 'meter-disc-evt-7712', detail: 'Credit exhausted at 02:14; meter opened contactor' },
      { account_id: prepaidAccountIds[3], action: 'reconnect', reason: 'credit_restored', actor_user_id: ESTATE_USERS[3], enforced_at_meter: true, evidence_ref: 'meter-rec-evt-7713', detail: 'Reconnected after ₦25,000 vend' },
      { account_id: prepaidAccountIds[5], action: 'disconnect', reason: 'operator_request', actor_user_id: OPS, enforced_at_meter: false, detail: 'Planned maintenance window' },
      { account_id: prepaidAccountIds[5], action: 'reconnect', reason: 'operator_request', actor_user_id: OPS, enforced_at_meter: false, detail: 'Maintenance complete' },
    ]);

    // -- 12. contracts ------------------------------------------------------
    console.log('📜 contracts');
    const contractRows: any[] = [];
    [...ESTATE_USERS, ...NG_PEOPLE.slice(5, 12)].forEach((u, i) => {
      contractRows.push({
        userId: u,
        contractType: i % 3 === 0 ? 'prepaid' : 'asset_aggregation',
        revenueSharePercentage: 70,
        monthlyFee: i % 3 === 0 ? 0 : 250_000,
        minimumRevenue: 0,
        startDate: ago(ri(60, 250) * 24),
        endDate: i % 6 === 5 ? ago(10 * 24) : null,
        status: i % 6 === 5 ? 'expired' : 'active',
        signedAt: ago(ri(60, 250) * 24),
      });
    });
    contractRows.push(
      { userId: BIZ_IKEJA, contractType: 'full_control', revenueSharePercentage: 80, monthlyFee: 5_000_000, minimumRevenue: 40_000_000, startDate: ago(290 * 24), status: 'active', signedAt: ago(290 * 24), metadata: J({ takeOrPay: 'TOP-2025-014', captiveMw: 8 }) },
      { userId: BIZ_KANO, contractType: 'full_control', revenueSharePercentage: 78, monthlyFee: 4_200_000, minimumRevenue: 30_000_000, startDate: ago(250 * 24), status: 'active', signedAt: ago(250 * 24), metadata: J({ franchiseMw: 7 }) },
    );
    await ins('contracts', contractRows);

    // -- 13. trading preferences / strategies / templates ------------------
    console.log('🎛 trading preferences & strategies');
    const prefUsers = [...ESTATE_USERS, ...NG_PEOPLE.slice(5, 15)];
    await ins('tradingPreferences', prefUsers.map((u, i) => ({
      userId: u,
      tradingMode: i % 3 === 0 ? 'automatic' : i % 3 === 1 ? 'hybrid' : 'manual',
      minExportPrice: 6_000 + i * 100,
      maxImportPrice: 18_000,
      minBatteryLevel: 2000,
      maxBatteryLevel: 9000,
      enableP2P: i % 2 === 0,
      enableNotifications: true,
    })));
    await ins('strategy_templates', [
      { name: 'Solar Self-Consumption Maximiser', description: 'Hold solar for own load; export only surplus above battery headroom.', category: 'self_consumption', icon: 'Sun', conditions: J({ minSoc: 20 }), tradingMode: 'both', priority: 10, expectedPerformance: J({ upliftPct: 8 }), tags: J(['solar', 'battery']), difficulty: 'beginner' },
      { name: 'Peak Price Exporter', description: 'Discharge battery into the 17:00–21:00 super-peak window.', category: 'arbitrage', icon: 'TrendingUp', conditions: J({ minPrice: 15000 }), tradingMode: 'automatic', priority: 8, expectedPerformance: J({ upliftPct: 14 }), tags: J(['arbitrage', 'peak']), difficulty: 'intermediate' },
      { name: 'DR First Responder', description: 'Always opt in to peak-shaving events above 20k/kWh comp.', category: 'demand_response', icon: 'Zap', conditions: J({ minComp: 20000 }), tradingMode: 'both', priority: 9, expectedPerformance: J({ upliftPct: 6 }), tags: J(['dr']), difficulty: 'beginner' },
      { name: 'Take-or-Pay Guard', description: 'Keep captive gas within take-or-pay band; never export below contract floor.', category: 'industrial', icon: 'Factory', conditions: J({ floorMw: 5 }), tradingMode: 'automatic', priority: 10, expectedPerformance: J({ upliftPct: 3 }), tags: J(['industrial', 'gas']), difficulty: 'advanced' },
    ]);
    await ins('trading_strategies', [
      { userId: ESTATE_USERS[0], name: 'Villa 1 evening export', description: 'Export 18:00–21:00 when price > ₦150/kWh', isActive: true, conditions: J({ hours: [18, 19, 20, 21], minPrice: 15000 }), tradingMode: 'automatic', priority: 9, performanceMetrics: J({ last30dRevenue: 1_250_000 }), lastActivatedAt: ago(5 * 24) },
      { userId: ESTATE_USERS[1], name: 'Villa 2 conservative', description: 'Manual trades only', isActive: false, conditions: J({}), tradingMode: 'manual', priority: 1 },
      { userId: BIZ_IKEJA, name: 'Captive plant ToP guard', description: 'Maintain take-or-pay offtake band', isActive: true, conditions: J({ minLoadMw: 5.2, maxLoadMw: 7.8 }), tradingMode: 'automatic', priority: 10, performanceMetrics: J({ topCompliancePct: 98.4 }), lastActivatedAt: ago(12 * 24) },
      { userId: BIZ_KANO, name: 'Franchise peak support', description: 'Feeder F2 evening support', isActive: true, conditions: J({ feeder: 'F2' }), tradingMode: 'hybrid', priority: 7, lastActivatedAt: ago(2 * 24) },
    ]);

    // -- 14. trades + p2p ---------------------------------------------------
    console.log('🔁 trades / p2p_matches / p2p_settlements');
    const tradeRows: any[] = [];
    for (let i = 0; i < 16; i++) {
      const u = ESTATE_USERS[i % 5];
      const isExport = i % 2 === 0;
      const energy = ri(2, 60) * 1000; // Wh
      const price = ri(6_000, 19_000); // cents/kWh
      tradeRows.push({
        userId: u,
        tradeType: isExport ? 'export' : 'import',
        tradingMode: i % 3 === 0 ? 'automatic' : 'manual',
        energy,
        price,
        totalAmount: Math.round((energy / 1000) * price),
        timestamp: ago(ri(2, 29 * 24)),
        status: pick(['executed', 'executed', 'executed', 'pending', 'cancelled', 'failed']),
      });
    }
    const tradeIds = await insRet('trades', tradeRows);
    // P2P trade pairs
    const p2pPairs: Array<[number, number, number]> = [
      [ESTATE_USERS[0], ESTATE_USERS[2], 25_000],
      [ESTATE_USERS[1], ESTATE_USERS[4], 18_000],
      [ESTATE_USERS[2], ESTATE_USERS[3], 12_000],
    ];
    const p2pBuyTradeIds: number[] = [];
    const p2pSellTradeIds: number[] = [];
    for (const [seller, buyer, wh] of p2pPairs) {
      const price = 9_500;
      const [sellId, buyId] = await insRet('trades', [
        { userId: seller, tradeType: 'p2p_sell', tradingMode: 'p2p', energy: wh, price, totalAmount: Math.round((wh / 1000) * price), timestamp: ago(ri(20, 100)), status: 'executed', counterpartyId: buyer },
        { userId: buyer, tradeType: 'p2p_buy', tradingMode: 'p2p', energy: wh, price, totalAmount: Math.round((wh / 1000) * price), timestamp: ago(ri(20, 100)), status: 'executed', counterpartyId: seller },
      ]);
      p2pSellTradeIds.push(sellId);
      p2pBuyTradeIds.push(buyId);
    }
    // buyer payments for the p2p purchases
    const p2pPaymentIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [id] = await insRet('payments', [{
        userId: p2pPairs[i][1],
        paymentType: 'p2p_trade',
        amount: Math.round((p2pPairs[i][2] / 1000) * 9_500),
        currency: 'NGN',
        paymentMethod: i === 0 ? 'paystack' : i === 1 ? 'flutterwave' : 'bank_transfer',
        transactionId: `PSK-P2P-${String(i + 1).padStart(4, '0')}`,
        status: i < 2 ? 'completed' : 'pending',
        p2pTradeId: p2pBuyTradeIds[i],
        createdAt: ago(ri(18, 96)),
      }]);
      p2pPaymentIds.push(id);
    }
    const matchRows: any[] = [];
    for (let i = 0; i < 5; i++) {
      const pr = p2pPairs[i % 3];
      const wh = pr[2];
      matchRows.push({
        buyOrderId: p2pBuyTradeIds[i % 3],
        sellOrderId: p2pSellTradeIds[i % 3],
        buyerId: pr[1],
        sellerId: pr[0],
        energyWh: wh,
        priceCentsPerKwh: 9_500,
        totalAmountCents: Math.round((wh / 1000) * 9_500),
        executedAt: ago(ri(18, 96)),
      });
    }
    const matchIds = await insRet('p2p_matches', matchRows);
    await ins('p2p_settlements', [
      { // fully complete settlement
        buyTradeId: p2pBuyTradeIds[0], sellTradeId: p2pSellTradeIds[0],
        buyerId: p2pPairs[0][1], sellerId: p2pPairs[0][0],
        energyWh: p2pPairs[0][2], amountCents: Math.round((p2pPairs[0][2] / 1000) * 9_500), currency: 'NGN',
        buyerPaymentId: p2pPaymentIds[0], buyerPaymentReference: 'PSK-P2P-0001', buyerPaidAt: ago(60),
        delivery: 'measured', deliveredEnergyWh: Math.round(p2pPairs[0][2] * 0.98), deliverySamples: 48, deliveryMeasuredAt: ago(48),
        sellerPayout: 'evidenced', sellerPayoutReference: 'PAYOUT-SEED-0001', sellerPaidAt: ago(40),
        state: 'complete', reconciliation: 'matched', reconciledAt: ago(36),
      },
      { // buyer paid, awaiting payout provider
        buyTradeId: p2pBuyTradeIds[1], sellTradeId: p2pSellTradeIds[1],
        buyerId: p2pPairs[1][1], sellerId: p2pPairs[1][0],
        energyWh: p2pPairs[1][2], amountCents: Math.round((p2pPairs[1][2] / 1000) * 9_500), currency: 'NGN',
        buyerPaymentId: p2pPaymentIds[1], buyerPaymentReference: 'PSK-P2P-0002', buyerPaidAt: ago(30),
        delivery: 'unmeasured', sellerPayout: 'unavailable_no_provider',
        state: 'buyer_paid_seller_unpaid', reconciliation: 'pending',
      },
      { // unresolved
        buyTradeId: p2pBuyTradeIds[2], sellTradeId: p2pSellTradeIds[2],
        buyerId: p2pPairs[2][1], sellerId: p2pPairs[2][0],
        energyWh: p2pPairs[2][2], amountCents: Math.round((p2pPairs[2][2] / 1000) * 9_500), currency: 'NGN',
        delivery: 'unmeasured', sellerPayout: 'unavailable_no_provider',
        state: 'unresolved', reconciliation: 'pending',
      },
    ]);

    // -- 15. demand response ----------------------------------------------
    console.log('⚡ demand response suite');
    const [drE0, drE1, drE2, drE3] = await insRet('demandResponseEvents', [
      { operatorId: ADMIN, eventName: 'Lekki Evening Peak Shaving', eventType: 'peak_shaving', targetReduction: 800, startTime: ago(26), endTime: ago(23), compensationRate: 25_000, status: 'completed', actualReduction: 762, metadata: J({ region: 'NG-LAGOS', feeder: 'LKJ-P1' }) },
      { operatorId: OPS, eventName: 'Kano Feeder F2 Emergency Support', eventType: 'emergency', targetReduction: 1_200, startTime: ago(7 * 24), endTime: ago(7 * 24 - 2), compensationRate: 40_000, status: 'completed', actualReduction: 1_105 },
      { operatorId: ADMIN, eventName: 'Economic Dispatch — Super-Peak Price Response', eventType: 'economic', targetReduction: 500, startTime: ahead(28), endTime: ahead(30), compensationRate: 22_000, status: 'scheduled' },
      { operatorId: ADMIN, eventName: 'Weekend Load Shift (cancelled — weather)', eventType: 'load_shifting', targetReduction: 300, startTime: ago(4 * 24), endTime: ago(4 * 24 - 3), compensationRate: 18_000, status: 'cancelled' },
    ]);
    const drParticipantUsers = [...ESTATE_USERS, BIZ_IKEJA, BIZ_KANO, ...NG_PEOPLE.slice(10, 13)];
    const drParticipantIds = await insRet('drParticipants', drParticipantUsers.map((u, i) => ({
      userId: u,
      enrolledAt: ago(ri(30, 200) * 24),
      status: i === 9 ? 'paused' : 'active',
      autoOptIn: i % 4 !== 3,
      minCompensation: 15_000 + i * 1_000,
      maxReduction: u === BIZ_IKEJA ? 2_000 : u === BIZ_KANO ? 1_500 : ri(3, 12),
      notificationPreferences: J({ email: true, sms: true, push: i % 2 === 0 }),
    })));
    const drResponseRows: any[] = [];
    const respFor = (eventId: number, u: number, i: number, completed: boolean) => ({
      eventId,
      userId: u,
      participationStatus: i % 5 === 4 ? 'opted_out' : i % 3 === 0 ? 'auto_enrolled' : 'opted_in',
      targetReduction: u === BIZ_IKEJA ? 1_800 : ri(3, 10),
      actualReduction: completed && i % 5 !== 4 ? (u === BIZ_IKEJA ? 1_720 : ri(2, 9)) : null,
      compensation: completed && i % 5 !== 4 ? ri(20, 400) * 25_000 : null,
      responseTime: ago(ri(24, 30)),
      completedAt: completed ? ago(22) : null,
    });
    drParticipantUsers.slice(0, 7).forEach((u, i) => drResponseRows.push(respFor(drE0, u, i, true)));
    drParticipantUsers.slice(3, 8).forEach((u, i) => drResponseRows.push(respFor(drE1, u, i + 1, true)));
    const drResponseIds = await insRet('drResponses', drResponseRows);
    const drCompRows: any[] = [];
    drResponseRows.forEach((r, i) => {
      if (!r.compensation) return;
      drCompRows.push({
        userId: r.userId,
        eventId: r.eventId,
        responseId: drResponseIds[i],
        amount: r.compensation,
        currency: 'NGN',
        status: i % 3 === 0 ? 'pending' : 'paid',
        paymentMethod: 'bank_transfer',
        paymentReference: i % 3 === 0 ? null : `DRC-SEED-${String(i).padStart(4, '0')}`,
        paidAt: i % 3 === 0 ? null : ago(ri(6, 20)),
      });
    });
    const drCompIds = await insRet('drCompensation', drCompRows);

    const drTemplateIds = await insRet('dr_event_templates', [
      { name: 'Evening Peak Shave (2h)', event_type: 'peak_shaving', default_duration: 120, default_target_reduction: 800, default_compensation_rate: 25_000, trigger_condition: 'peak_forecast', trigger_threshold: 7_500, advance_notice_minutes: 180, notification_channels: J(['email', 'sms', 'push']), is_active: 'true' },
      { name: 'Grid Stress Emergency', event_type: 'emergency', default_duration: 60, default_target_reduction: 1_500, default_compensation_rate: 40_000, trigger_condition: 'grid_stress', trigger_threshold: 4_950, advance_notice_minutes: 15, notification_channels: J(['sms', 'push']), is_active: 'true' },
      { name: 'Price Spike Response', event_type: 'economic', default_duration: 90, default_target_reduction: 400, default_compensation_rate: 22_000, trigger_condition: 'price_spike', trigger_threshold: 20_000, advance_notice_minutes: 60, notification_channels: J(['push']), is_active: 'true' },
      { name: 'Renewable Surplus Absorption', event_type: 'load_shifting', default_duration: 180, default_target_reduction: -600, default_compensation_rate: 8_000, trigger_condition: 'renewable_surplus', trigger_threshold: 70, advance_notice_minutes: 240, notification_channels: J(['email']), is_active: 'false' },
    ]);
    await ins('dr_automation_rules', [
      { name: 'Auto-shave on evening load > 7.5MW', template_id: drTemplateIds[0], condition: 'load_threshold', operator: 'greater_than', threshold: 7_500, active_hours_start: 16, active_hours_end: 21, active_days: '[1,2,3,4,5]', cooldown_minutes: 240, last_triggered: ago(26), is_enabled: 'true', priority: 8 },
      { name: 'Emergency on frequency < 49.5Hz', template_id: drTemplateIds[1], condition: 'grid_frequency', operator: 'less_than', threshold: 4_950, cooldown_minutes: 60, last_triggered: ago(7 * 24), is_enabled: 'true', priority: 10 },
      { name: 'Price spike > ₦200/kWh', template_id: drTemplateIds[2], condition: 'price_threshold', operator: 'greater_than', threshold: 20_000, cooldown_minutes: 120, is_enabled: 'false', priority: 5 },
    ]);
    const drForecastRows: any[] = [];
    for (let hI = 0; hI < 24; hI++) {
      drForecastRows.push({
        forecast_date: dayStartHoursAgo(0),
        forecast_hour: hI,
        predicted_load: 5_800 + Math.round(1_800 * Math.exp(-Math.pow(hI - 19, 2) / 8)),
        predicted_peak: 7_900,
        dr_potential: 900 + ri(0, 300),
        confidence: ri(72, 94),
        grid_status: hI >= 17 && hI <= 21 ? 'stressed' : 'normal',
        temperature: 285 + ri(0, 60),
        weather_condition: pick(['harmattan haze', 'clear', 'scattered clouds']),
        recommended_action: hI >= 17 && hI <= 21 ? 'prepare_event' : hI >= 15 ? 'monitor' : 'none',
        recommended_reduction: hI >= 17 && hI <= 21 ? 800 : null,
      });
    }
    await ins('dr_forecasts', drForecastRows);
    const drEventForecastRows: any[] = [];
    for (let dI = 0; dI < 7; dI++) {
      const dt = new Date(dayStartHoursAgo(0).getTime() + dI * D);
      drEventForecastRows.push({
        forecast_date: dt,
        weekday: dt.getUTCDay(),
        likelihood_percent: ri(15, 78),
        history_frequency_percent: ri(20, 60),
        demand_trend_percent: ri(-5, 12),
        heat_factor_percent: ri(0, 30),
        weather_used: true,
        history_event_count: ri(2, 18),
      });
    }
    await ins('dr_event_forecasts', drEventForecastRows);
    await ins('dr_campaigns', [
      { name: 'Lekki Peak Heroes Q1', description: 'Recruit high-reliability estate homes for evening events', eventId: drE0, targetSegments: J(['gold', 'platinum']), minScore: 70, maxParticipants: 40, bonusCompensation: 5_000, status: 'completed', scheduledStart: ago(8 * 24), scheduledEnd: ago(2 * 24), participantsInvited: 24, participantsAccepted: 17, totalReduction: 762, totalCompensation: 1_905_000, createdBy: ADMIN },
      { name: 'Kano Industrial Reserve', description: 'Standby capacity from franchise customers', eventId: drE1, targetSegments: J(['silver', 'gold']), minScore: 55, maxParticipants: 10, status: 'active', scheduledStart: ago(3 * 24), scheduledEnd: ahead(10 * 24), participantsInvited: 8, participantsAccepted: 5, createdBy: OPS },
    ]);
    const drRecRows: any[] = [];
    drParticipantUsers.slice(0, 8).forEach((u, i) => {
      drRecRows.push({
        forecast_id: null,
        event_id: drE0,
        recommended_for_date: ago(26),
        user_id: u,
        rank_position: i + 1,
        score_milli: 92_000 - i * 3_500,
        compliance_percent: ri(80, 99),
        flexibility_kw10: (u === BIZ_IKEJA ? 1_800 : ri(3, 10)) * 10,
        no_show_count: i % 4,
        outcome: i === 6 ? 'no_show' : i === 5 ? 'declined' : 'participated',
        outcome_recorded_at: ago(22),
      });
    });
    await ins('dr_participant_recommendations', drRecRows);
    await ins('participant_segments', [
      { name: 'platinum', description: 'Top reliability, instant response', minOverallScore: 90, minReliabilityScore: 92, minParticipationRate: 90, minCapacity: 5, priority: 4, compensationMultiplier: 130 },
      { name: 'gold', description: 'Consistent responders', minOverallScore: 78, minReliabilityScore: 80, minParticipationRate: 75, priority: 3, compensationMultiplier: 115 },
      { name: 'silver', description: 'Regular participants', minOverallScore: 60, minReliabilityScore: 60, minParticipationRate: 55, priority: 2, compensationMultiplier: 100 },
      { name: 'bronze', description: 'New or occasional participants', priority: 1, compensationMultiplier: 90 },
    ]);
    await ins('participant_scores', drParticipantUsers.slice(0, 8).map((u, i) => ({
      userId: u,
      reliabilityScore: 95 - i * 4,
      responseTimeScore: 90 - i * 3,
      reductionAccuracyScore: 88 - i * 3,
      participationRateScore: 92 - i * 5,
      overallScore: 91 - i * 4,
      totalEventsParticipated: 14 - i,
      totalEventsOptedOut: i % 3,
      averageReduction: u === BIZ_IKEJA ? 1_750 : ri(3, 9),
      totalCompensationEarned: ri(5, 90) * 250_000,
      maxCapacity: u === BIZ_IKEJA ? 2_000 : ri(4, 12),
      averageResponseTime: ri(2, 14),
      segment: i < 2 ? 'platinum' : i < 5 ? 'gold' : 'silver',
    })));
    await ins('leaderboard_entries', drParticipantUsers.map((u, i) => ({
      user_id: u,
      period: 'weekly',
      period_start: dayStartHoursAgo(7),
      period_end: dayStartHoursAgo(0),
      rank: i + 1,
      score: 9_400 - i * 260,
      events_participated: 4 - Math.floor(i / 3),
      total_reduction: (u === BIZ_IKEJA ? 5_400 : ri(8, 60)),
      compensation_earned: ri(10, 200) * 25_000,
      reliability_score: 96 - i * 2,
      reward_amount: i < 3 ? 500_000 - i * 150_000 : null,
      reward_paid: i < 2,
    })));

    // -- 16. grid network model (Kano 7MW franchise + TZ microgrid) --------
    console.log('🕸 grid network model');
    const nodeIds = await insRet('grid_nodes', [
      { code: 'KN-SUB-01', name: 'Kano Franchise 33kV Injection Substation', kind: 'substation', parent_node_id: null, region: 'NG-KANO', firm_capacity_w: 7_000_000, nominal_volts: 33_000, is_source: true, voltage_min_pu_x1000: 950, voltage_max_pu_x1000: 1050 },
      { code: 'KN-FDR-F1', name: 'Feeder F1 — Industrial Estate', kind: 'feeder', parent_node_id: null, region: 'NG-KANO', nominal_volts: 11_000, voltage_min_pu_x1000: 930, voltage_max_pu_x1000: 1070 },
      { code: 'KN-FDR-F2', name: 'Feeder F2 — Residential', kind: 'feeder', parent_node_id: null, region: 'NG-KANO', nominal_volts: 11_000, voltage_min_pu_x1000: 930, voltage_max_pu_x1000: 1070 },
      { code: 'KN-T1', name: 'T1 11/0.415kV — Textile Mill', kind: 'transformer', parent_node_id: null, region: 'NG-KANO', nominal_volts: 415 },
      { code: 'KN-T2', name: 'T2 11/0.415kV — Market Cluster', kind: 'transformer', parent_node_id: null, region: 'NG-KANO', nominal_volts: 415 },
      { code: 'KN-T3', name: 'T3 11/0.415kV — Residential Block C', kind: 'transformer', parent_node_id: null, region: 'NG-KANO', nominal_volts: 415 },
      { code: 'DSM-PCC-01', name: 'Dar es Salaam Microgrid PCC', kind: 'substation', parent_node_id: null, region: 'TZ-DSM', nominal_volts: 11_000, is_source: true, voltage_min_pu_x1000: 950, voltage_max_pu_x1000: 1050 },
      { code: 'ARS-FDR-01', name: 'Arusha Prosumer Feeder', kind: 'feeder', parent_node_id: null, region: 'TZ-ARUSHA', nominal_volts: 415 },
    ]);
    const [N_SUB, N_F1, N_F2, N_T1, N_T2, N_T3, N_DSM, N_ARS] = nodeIds;
    // fix parent links
    await client.query(`UPDATE grid_nodes SET parent_node_id=$2 WHERE id=$1`, [N_F1, N_SUB]);
    await client.query(`UPDATE grid_nodes SET parent_node_id=$2 WHERE id=$1`, [N_F2, N_SUB]);
    await client.query(`UPDATE grid_nodes SET parent_node_id=$2 WHERE id=$1`, [N_T1, N_F1]);
    await client.query(`UPDATE grid_nodes SET parent_node_id=$2 WHERE id=$1`, [N_T2, N_F2]);
    await client.query(`UPDATE grid_nodes SET parent_node_id=$2 WHERE id=$1`, [N_T3, N_F2]);
    await client.query(`UPDATE grid_nodes SET parent_node_id=$2 WHERE id=$1`, [N_ARS, N_DSM]);

    await ins('grid_network_lines', [
      { code: 'KN-L-01', from_node_id: N_SUB, to_node_id: N_F1, length_m: 2_400, resistance_mohm_per_km: 210, reactance_mohm_per_km: 360, capacitance_nf_per_km: 280, max_current_ma: 320_000, parallel_circuits: 1, data_source: 'GIS import 2025-11' },
      { code: 'KN-L-02', from_node_id: N_SUB, to_node_id: N_F2, length_m: 1_800, resistance_mohm_per_km: 210, reactance_mohm_per_km: 360, capacitance_nf_per_km: 280, max_current_ma: 320_000, parallel_circuits: 1, data_source: 'GIS import 2025-11' },
      { code: 'KN-L-03', from_node_id: N_F1, to_node_id: N_T1, length_m: 400, resistance_mohm_per_km: 340, reactance_mohm_per_km: 380, max_current_ma: 180_000, data_source: 'as-built survey' },
      { code: 'KN-L-04', from_node_id: N_F2, to_node_id: N_T2, length_m: 600, resistance_mohm_per_km: 340, reactance_mohm_per_km: 380, max_current_ma: 140_000, data_source: 'as-built survey' },
      { code: 'KN-L-05', from_node_id: N_F2, to_node_id: N_T3, length_m: 750, resistance_mohm_per_km: 340, reactance_mohm_per_km: 380, max_current_ma: 120_000, data_source: 'as-built survey' },
    ]);
    await ins('grid_network_transformers', [
      { code: 'KN-TX-T1', hv_node_id: N_F1, lv_node_id: N_T1, rated_kva: 500, hv_volts: 11_000, lv_volts: 415, short_circuit_percent_x100: 475, short_circuit_resistive_percent_x100: 110, iron_loss_w: 890, open_loop_current_percent_x100: 90, data_source: 'nameplate' },
      { code: 'KN-TX-T2', hv_node_id: N_F2, lv_node_id: N_T2, rated_kva: 300, hv_volts: 11_000, lv_volts: 415, short_circuit_percent_x100: 420, short_circuit_resistive_percent_x100: 100, iron_loss_w: 610, open_loop_current_percent_x100: 110, data_source: 'nameplate' },
      { code: 'KN-TX-T3', hv_node_id: N_F2, lv_node_id: N_T3, rated_kva: 200, hv_volts: 11_000, lv_volts: 415, short_circuit_percent_x100: 400, short_circuit_resistive_percent_x100: 95, iron_loss_w: 450, open_loop_current_percent_x100: 120, data_source: 'nameplate' },
    ]);
    await ins('grid_node_assets', [
      { node_id: N_F1, asset_id: TURBINE, link_source: 'utility_verified', linked_by_user_id: OPS, evidence: 'Protection relay schedule RP-114', verified_at: ago(120 * 24) },
      { node_id: N_F2, asset_id: COMM_SOLAR, link_source: 'utility_verified', linked_by_user_id: OPS, evidence: 'Connection agreement CA-2025-032', verified_at: ago(110 * 24) },
      { node_id: N_F1, asset_id: F1_METER, link_source: 'utility_verified', linked_by_user_id: OPS, evidence: 'Metering point register', verified_at: ago(150 * 24) },
      { node_id: N_F2, asset_id: F2_METER, link_source: 'utility_verified', linked_by_user_id: OPS, evidence: 'Metering point register', verified_at: ago(150 * 24) },
      { node_id: N_T1, asset_id: GEN1, link_source: 'operator_declared', linked_by_user_id: BIZ_KANO },
      { node_id: N_ARS, asset_id: A(24), link_source: 'operator_declared', linked_by_user_id: U(26) },
      { node_id: N_ARS, asset_id: A(27), link_source: 'unverified', linked_by_user_id: U(27) },
      { node_id: N_ARS, asset_id: A(33), link_source: 'unverified', linked_by_user_id: U(28) },
    ]);

    const feasIds = await insRet('network_feasibility_studies', [
      { subject: 'connection_enquiry', subject_reference: 'ENQ-2026-011', node_id: N_F1, status: 'feasible', engine: 'vpp-loadflow/1.4.0', buses: 8, violation_count: 0, request: J({ addLoadW: 250_000 }), response: J({ marginW: 1_150_000 }), requested_by_user_id: BIZ_KANO, created_at: ago(9 * 24) },
      { subject: 'flexibility_clearing', subject_reference: 'FLEX-CLR-044', node_id: N_F2, status: 'violations', reason: 'T2 thermal limit exceeded at 18:00 peak', engine: 'vpp-loadflow/1.4.0', buses: 8, violation_count: 2, limiting_element: 'KN-TX-T2', request: J({ reduceW: 900_000 }), response: J({ clearedW: 620_000 }), requested_by_user_id: OPS, created_at: ago(3 * 24) },
    ]);

    // -- 17. locational flexibility ----------------------------------------
    console.log('📍 locational flexibility');
    const flexReqIds = await insRet('flexibility_requirements', [
      { node_id: N_F2, direction: 'import_reduction', status: 'settled', starts_at: ago(3 * 24 + 6), ends_at: ago(3 * 24 - 3), required_power_w: 900_000, price_cap_cents_per_kwh: 45_000, currency: 'NGN', cleared_power_w: 620_000, clearing_price_cents_per_kwh: 38_000, created_by_user_id: OPS, cleared_at: ago(4 * 24), notes: 'T2 overload relief' },
      { node_id: N_F1, direction: 'import_reduction', status: 'open', starts_at: ahead(30), ends_at: ahead(33), required_power_w: 1_200_000, price_cap_cents_per_kwh: 42_000, currency: 'NGN', created_by_user_id: ADMIN, notes: 'Planned maintenance on L-01' },
    ]);
    const flexOfferIds = await insRet('flexibility_offers', [
      { requirement_id: flexReqIds[0], asset_id: BATT_IND, user_id: BIZ_IKEJA, status: 'awarded', offered_power_w: 500_000, price_cents_per_kwh: 36_000, link_source: 'operator_declared' },
      { requirement_id: flexReqIds[0], asset_id: GEN1, user_id: BIZ_IKEJA, status: 'awarded', offered_power_w: 300_000, price_cents_per_kwh: 38_000, link_source: 'operator_declared' },
      { requirement_id: flexReqIds[0], asset_id: GEN2, user_id: BIZ_IKEJA, status: 'not_awarded', offered_power_w: 250_000, price_cents_per_kwh: 44_000, link_source: 'operator_declared' },
      { requirement_id: flexReqIds[1], asset_id: BATT_E0, user_id: ESTATE_USERS[0], status: 'submitted', offered_power_w: 8_000, price_cents_per_kwh: 30_000, link_source: 'unverified' },
    ]);
    await ins('flexibility_awards', [
      { requirement_id: flexReqIds[0], offer_id: flexOfferIds[0], asset_id: BATT_IND, user_id: BIZ_IKEJA, awarded_power_w: 500_000, price_cents_per_kwh: 38_000, delivery_status: 'delivered', baseline_power_w: 520_000, baseline_samples: 12, measured_power_w: 18_000, measured_samples: 36, delivered_power_w: 502_000, delivered_energy_wh: 1_506_000, earned_amount: 5_722_800, measured_at: ago(3 * 24 - 3), network_check_status: 'feasible', network_study_id: feasIds[1] },
      { requirement_id: flexReqIds[0], offer_id: flexOfferIds[1], asset_id: GEN1, user_id: BIZ_IKEJA, awarded_power_w: 300_000, price_cents_per_kwh: 38_000, delivery_status: 'partial', baseline_power_w: 305_000, baseline_samples: 12, measured_power_w: 96_000, measured_samples: 36, delivered_power_w: 209_000, delivered_energy_wh: 627_000, earned_amount: 2_382_600, measured_at: ago(3 * 24 - 3), network_check_status: 'feasible', network_study_id: feasIds[1] },
    ]);

    // -- 18. DER capabilities / constraints / grid services -----------------
    console.log('🔧 DER capabilities & grid services');
    await ins('der_capabilities', [
      { asset_id: BATT_IND, max_power_export: 800_000, max_power_import: 600_000, min_power_export: 10_000, ramp_rate_up: 200_000, ramp_rate_down: 200_000, max_soc: 9500, min_soc: 1000, round_trip_efficiency: 9_000, response_time_ms: 250, can_provide_frequency_response: true, can_provide_voltage_support: true, can_provide_reserves: true, can_provide_peak_shaving: true, protocols: J(['modbus', 'mqtt']) },
      { asset_id: GEN1, max_power_export: 4_000_000, ramp_rate_up: 120_000, ramp_rate_down: 150_000, minimum_run_time: 3_600, minimum_off_time: 900, response_time_ms: 30_000, can_provide_reserves: true, can_provide_peak_shaving: true, protocols: J(['modbus']) },
      { asset_id: GEN2, max_power_export: 4_000_000, ramp_rate_up: 120_000, ramp_rate_down: 150_000, minimum_run_time: 3_600, minimum_off_time: 900, response_time_ms: 30_000, can_provide_reserves: true, can_provide_peak_shaving: true, protocols: J(['modbus']) },
      { asset_id: TURBINE, max_power_export: 7_000_000, ramp_rate_up: 350_000, ramp_rate_down: 400_000, minimum_run_time: 7_200, response_time_ms: 45_000, can_provide_reserves: true, can_provide_peak_shaving: true, protocols: J(['modbus']) },
      { asset_id: BATT_E0, max_power_export: 5_000, max_power_import: 5_000, max_soc: 9800, min_soc: 1500, round_trip_efficiency: 8_900, response_time_ms: 400, can_provide_peak_shaving: true, protocols: J(['mqtt']) },
      { asset_id: PV_IND, max_power_export: 500_000, can_provide_voltage_support: true, protocols: J(['modbus', 'mqtt']) },
    ]);
    await ins('der_constraints', [
      { asset_id: BATT_IND, valid_from: ago(5 * 24), valid_until: ahead(25 * 24), constraint_type: 'min_soc', constraint_value: 2_000, priority: 8, source: 'operator', reason: 'Reserve headroom for evening DR events' },
      { asset_id: GEN1, valid_from: ago(10 * 24), valid_until: ahead(80 * 24), constraint_type: 'must_run', constraint_value: 2_400_000, priority: 9, source: 'operator', reason: 'Take-or-pay minimum offtake band' },
      { asset_id: BATT_E0, valid_from: ago(2 * 24), valid_until: ahead(28 * 24), constraint_type: 'user_preference', constraint_value: 3_000, priority: 5, source: 'user', reason: 'Keep 30% backup for outages' },
      { asset_id: TURBINE, valid_from: ago(30 * 24), valid_until: ahead(335 * 24), constraint_type: 'max_power', constraint_value: 6_800_000, priority: 7, source: 'safety', reason: 'Hot-day derating' },
    ]);
    const gspIds = await insRet('grid_service_products', [
      { service_code: 'NG-PS-01', service_name: 'Peak Shaving — Lagos', service_type: 'peak_shaving', market_region: 'NG-LAGOS', min_capacity_kw: 50, max_response_time_ms: 900_000, min_duration_minutes: 60, telemetry_interval_seconds: 60, compensation_type: 'capacity_plus_energy', base_rate_cents: 25_000, performance_multiplier: 120, is_active: true },
      { service_code: 'NG-FR-01', service_name: 'Frequency Regulation — NG', service_type: 'frequency_regulation', market_region: 'NG-LAGOS', min_capacity_kw: 100, max_response_time_ms: 2_000, min_duration_minutes: 15, telemetry_interval_seconds: 4, compensation_type: 'performance_based', base_rate_cents: 42_000, performance_multiplier: 150, is_active: true },
      { service_code: 'NG-CAP-01', service_name: 'Capacity Reserve — Kano Franchise', service_type: 'capacity', market_region: 'NG-KANO', min_capacity_kw: 500, max_response_time_ms: 1_800_000, min_duration_minutes: 120, telemetry_interval_seconds: 300, compensation_type: 'capacity_only', base_rate_cents: 12_000, is_active: true },
      { service_code: 'TZ-DR-01', service_name: 'Demand Response — Arusha', service_type: 'demand_response', market_region: 'TZ-ARUSHA', min_capacity_kw: 10, max_response_time_ms: 600_000, min_duration_minutes: 30, telemetry_interval_seconds: 60, compensation_type: 'energy_only', base_rate_cents: 18_000, is_active: false },
    ]);
    await ins('service_enrollments', [
      { asset_id: BATT_IND, service_product_id: gspIds[0], user_id: BIZ_IKEJA, enrolled_capacity_kw: 800, status: 'active', effective_from: ago(60 * 24), total_dispatches_count: 22, successful_dispatches_count: 21, performance_score: 96 },
      { asset_id: GEN1, service_product_id: gspIds[2], user_id: BIZ_IKEJA, enrolled_capacity_kw: 2_000, status: 'active', effective_from: ago(90 * 24), total_dispatches_count: 8, successful_dispatches_count: 8, performance_score: 99 },
      { asset_id: TURBINE, service_product_id: gspIds[2], user_id: BIZ_KANO, enrolled_capacity_kw: 3_000, status: 'active', effective_from: ago(90 * 24), total_dispatches_count: 5, successful_dispatches_count: 4, performance_score: 88 },
      { asset_id: BATT_E0, service_product_id: gspIds[0], user_id: ESTATE_USERS[0], enrolled_capacity_kw: 5, status: 'active', effective_from: ago(45 * 24), total_dispatches_count: 12, successful_dispatches_count: 11, performance_score: 92 },
      { asset_id: A(9), service_product_id: gspIds[0], user_id: ESTATE_USERS[1], enrolled_capacity_kw: 5, status: 'suspended', effective_from: ago(45 * 24), metadata: J({ reason: 'owner travelling' }) },
    ]);
    await ins('grid_protocol_instructions', [
      { source: 'openadr', external_id: 'EVT-NG-2026-0411', modification_number: 0, program_ref: 'NG-PS-01', event_status: 'completed', priority: 1, start_time: ago(26), duration_seconds: 7_200, target_watts: -800_000, decision: 'opt_in', decision_reason: 'Compensation above participant floor', payload: J({ signalType: 'simple', level: 3 }), received_at: ago(27) },
      { source: 'openadr', external_id: 'EVT-NG-2026-0418', modification_number: 0, program_ref: 'NG-PS-01', event_status: 'active', priority: 1, start_time: ahead(28), duration_seconds: 7_200, target_watts: -500_000, decision: 'recorded', decision_reason: 'Awaiting participant opt-in deadline', payload: J({ signalType: 'simple', level: 2 }), received_at: ago(2) },
      { source: 'sep2', external_id: 'DERC-0091', modification_number: 2, program_ref: 'NG-CAP-01', event_status: 'completed', priority: 5, start_time: ago(7 * 24), duration_seconds: 3_600, target_percent: 60, decision: 'opt_in', decision_reason: 'Within der capability envelope', payload: J({ functionSet: 'DERControl', opModExpLimW: 60 }), received_at: ago(7 * 24 + 1) },
      { source: 'openadr', external_id: 'EVT-TZ-2026-0202', modification_number: 0, program_ref: 'TZ-DR-01', event_status: 'cancelled', priority: 3, start_time: ago(10 * 24), duration_seconds: 1_800, decision: 'opt_out', decision_reason: 'Insufficient Tanzanian battery headroom', payload: J({ signalType: 'simple', level: 1 }), received_at: ago(10 * 24) },
    ]);

    // -- 19. forecasts + accuracy ------------------------------------------
    console.log('📈 forecasts');
    const [frLoad, frSolar, frPrice] = await insRet('forecast_runs', [
      { run_id: `FR-LOAD-${dayStartHoursAgo(0).toISOString().slice(0, 10)}`, forecast_type: 'load', scope_type: 'region', region: 'NG-LAGOS', model_version: 'load-xgb-2.3.1', model_type: 'xgboost', features: J(['hour', 'weekday', 'temperature', 'lag_24h']), forecast_horizon_hours: 48, interval_minutes: 60, mae_value: 184, rmse_value: 262, status: 'completed' },
      { run_id: `FR-SOLAR-${dayStartHoursAgo(0).toISOString().slice(0, 10)}`, forecast_type: 'solar_generation', scope_type: 'asset', scope_id: PV_IND, region: 'NG-LAGOS', model_version: 'solar-gbm-1.9.0', model_type: 'lightgbm', features: J(['ghi', 'cloud_cover', 'hour']), forecast_horizon_hours: 24, interval_minutes: 60, mae_value: 9_400, rmse_value: 14_800, status: 'completed' },
      { run_id: `FR-PRICE-${dayStartHoursAgo(0).toISOString().slice(0, 10)}`, forecast_type: 'price', scope_type: 'region', region: 'NG-LAGOS', model_version: 'price-lstm-3.1.2', model_type: 'lstm', features: J(['hour', 'load_forecast', 'gas_price']), forecast_horizon_hours: 24, interval_minutes: 60, status: 'running' },
    ]);
    const fvRows: any[] = [];
    for (let hI = 0; hI < 24; hI++) {
      const ts = new Date(dayStartHoursAgo(0).getTime() + hI * H);
      const load = 5_800 + Math.round(1_800 * Math.exp(-Math.pow(hI - 19, 2) / 8));
      fvRows.push(
        { run_id: frLoad, forecast_time: ts, p10_value: load - 320, p50_value: load, p90_value: load + 340, mean_value: load, confidence_score: 88 },
        { run_id: frLoad, forecast_time: new Date(ts.getTime() + D), p10_value: load - 350, p50_value: load + 40, p90_value: load + 410, mean_value: load + 40, confidence_score: 82 },
      );
      const pv = Math.round(500_000 * 0.78 * solarCurve(hI));
      fvRows.push({ run_id: frSolar, forecast_time: ts, p10_value: Math.round(pv * 0.7), p50_value: pv, p90_value: Math.round(pv * 1.08), mean_value: pv, confidence_score: pv > 0 ? 90 : 99 });
      const pt = priceTypeForHour(hI);
      const pr = pt === 'off_peak' ? 4_200 : pt === 'shoulder' ? 8_500 : pt === 'peak' ? 12_500 : 21_000;
      fvRows.push({ run_id: frPrice, forecast_time: ts, p10_value: pr - 400, p50_value: pr, p90_value: pr + 400, mean_value: pr, confidence_score: 80 });
    }
    await ins('forecast_values', fvRows);
    await ins('forecast_accuracy', [
      { run_id: `FR-LOAD-${dayStartHoursAgo(1).toISOString().slice(0, 10)}`, forecast_type: 'load', scope_type: 'region', region: 'NG-LAGOS', model_version: 'load-xgb-2.3.1', actual_source: 'grid_monitoring', status: 'scored', sample_count: 24, mae_value: 191, rmse_value: 270, mape_bp: 312, bias_value: -22, coverage_bp: 9_050, interval_width_value: 640, scored_through: dayStartHoursAgo(0), scored_at: ago(2) },
      { run_id: `FR-SOLAR-${dayStartHoursAgo(1).toISOString().slice(0, 10)}`, forecast_type: 'solar_generation', scope_type: 'asset', scope_id: PV_IND, region: 'NG-LAGOS', model_version: 'solar-gbm-1.9.0', actual_source: 'telemetry', status: 'scored', sample_count: 24, mae_value: 10_100, rmse_value: 15_600, mape_bp: 1_840, bias_value: 1_200, scored_through: dayStartHoursAgo(0), scored_at: ago(2) },
      { run_id: `FR-PRICE-${dayStartHoursAgo(1).toISOString().slice(0, 10)}`, forecast_type: 'price', scope_type: 'region', region: 'NG-LAGOS', model_version: 'price-lstm-3.1.2', actual_source: 'market_prices', status: 'insufficient_actuals', sample_count: 6, scored_through: ago(18), scored_at: ago(1) },
    ]);

    // -- 20. ML registry / training / predictions --------------------------
    console.log('🧠 ML suite');
    const [dsLake, dsSynth] = await insRet('training_datasets', [
      { name: 'lagos-load-telemetry-90d', origin: 'lakehouse', task: 'load_forecast', feature_spec: J({ horizon: 48, features: ['hour', 'weekday', 'temperature', 'lag_24h'] }), feature_spec_digest: hex(64), window_start: ago(90 * 24), window_end: dayStartHoursAgo(0), rows: 2_160, sequences: 2_050, entities: 7, source_objects: ['s3://vpp-lake/telemetry/2026-W14.parquet', 's3://vpp-lake/telemetry/2026-W15.parquet'], source_digests: [hex(64), hex(64)], created_by: 'ml-pipeline' },
      { name: 'solar-clear-sky-synth-v3', origin: 'synthetic', task: 'solar_generation', feature_spec: J({ horizon: 24, features: ['ghi', 'cloud_cover', 'hour'] }), feature_spec_digest: hex(64), window_start: ago(120 * 24), window_end: dayStartHoursAgo(0), rows: 8_760, sequences: 8_500, entities: 4, generator: 'pv-synth', generator_version: '3.0.1', seed: 1337, created_by: 'ml-pipeline' },
    ]);
    const [mLoad, mSolar, mAnom] = await insRet('model_registry', [
      { model_name: 'load-xgb', model_version: '2.3.1', model_type: 'load_forecast', artifact_path: 's3://vpp-models/load-xgb/2.3.1/model.bin', artifact_hash: hex(64), training_data_start: ago(90 * 24), training_data_end: dayStartHoursAgo(0), training_duration_seconds: 1_840, framework: 'xgboost', input_schema: J({ features: 12 }), output_schema: J({ quantiles: ['p10', 'p50', 'p90'] }), training_samples: 2_050, validation_metrics: J({ mae: 184, rmse: 262 }), validation_mae: 184, validation_rmse: 262, validation_mape: 3, status: 'production', deployed_at: ago(14 * 24), training_dataset_id: dsLake },
      { model_name: 'solar-gbm', model_version: '1.9.0', model_type: 'generation_forecast', artifact_path: 's3://vpp-models/solar-gbm/1.9.0/model.bin', artifact_hash: hex(64), training_data_start: ago(120 * 24), training_data_end: dayStartHoursAgo(0), training_duration_seconds: 2_430, framework: 'lightgbm', training_samples: 8_500, validation_mae: 9_400, validation_rmse: 14_800, status: 'production', deployed_at: ago(21 * 24), training_dataset_id: dsSynth },
      { model_name: 'anomaly-iforest', model_version: '0.9.4', model_type: 'anomaly_detection', artifact_path: 's3://vpp-models/anomaly-iforest/0.9.4/model.bin', artifact_hash: hex(64), framework: 'sklearn', status: 'deprecated', deployed_at: ago(200 * 24), deprecated_at: ago(30 * 24) },
    ]);
    const [trOk] = await insRet('training_runs', [
      { dataset_id: dsLake, model_id: mLoad, model_name: 'load-xgb', model_kind: 'load_forecast', state: 'succeeded', framework: 'xgboost', framework_version: '2.0.3', compute: 'c6i.2xlarge spot', hyperparameters: J({ max_depth: 7, eta: 0.08, rounds: 600 }), epochs_requested: 600, epochs_ran: 540, train_sequences: 1_800, val_sequences: 250, split_at: ago(15 * 24), best_epoch: 540, train_loss: 0.0112, val_loss: 0.0144, metrics: J({ mae: 184, rmse: 262 }), checkpoint_path: 's3://vpp-models/load-xgb/2.3.1/model.bin', checkpoint_digest: hex(64), checkpoint_bytes: 4_812_100, started_at: ago(14 * 24 + 1), finished_at: ago(14 * 24), duration_seconds: 1_840, runner: 'ml-pipeline', trigger: 'scheduled' },
      { dataset_id: dsSynth, model_name: 'solar-gbm', model_kind: 'generation_forecast', state: 'failed', framework: 'lightgbm', framework_version: '4.3.0', compute: 'c6i.2xlarge spot', hyperparameters: J({ num_leaves: 63 }), epochs_requested: 800, runner: 'ml-pipeline', trigger: 'manual', error: 'Spot instance reclaimed at epoch 612; checkpoint upload incomplete', finished_at: ago(6 * 24) },
    ]);
    await client.query(`UPDATE model_registry SET training_run_id=$1 WHERE id=$2`, [trOk, mLoad]);
    await ins('model_predictions', Array.from({ length: 12 }, (_, i) => ({
      model_id: i % 2 === 0 ? mLoad : mSolar,
      input_hash: hex(64),
      predicted_value: (5_900 + i * 137).toFixed(2),
      actual_value: i < 9 ? (5_880 + i * 141).toFixed(2) : null,
      latency_ms: ri(8, 45),
      features: J({ hour: i * 2, weekday: 3 }),
      created_at: ago(ri(1, 72)),
    })));
    await ins('model_drift_events', [
      { model_id: mSolar, detected_at: ago(4 * 24), drift_type: 'data_drift', psi_score: 1_240, current_mae: 12_800, baseline_mae: 9_400, severity: 'medium', action_taken: 'alert_sent', metric_name: 'psi', current_value: 1_240, baseline_value: 420, threshold: 1_000, window_start: ago(11 * 24), window_end: ago(4 * 24), affected_features: J(['cloud_cover']), recommended_action: 'Schedule retrain with recent harmattan-haze samples' },
      { model_id: mLoad, detected_at: ago(20 * 24), drift_type: 'performance_degradation', psi_score: 640, current_mae: 231, baseline_mae: 184, severity: 'low', action_taken: 'none', resolved_at: ago(14 * 24), metadata: J({ note: 'Recovered after feature store backfill' }) },
    ]);
    await ins('model_feature_baselines', ['hour', 'weekday', 'temperature', 'lag_24h'].map((f, i) => ({
      model_id: mLoad,
      dataset_id: dsLake,
      feature: f,
      mean: [11.5, 2.9, 29.4, 6_120][i],
      std: [6.9, 2.0, 2.8, 1_410][i],
      p05: [1, 0, 25.1, 3_900][i],
      p50: [11, 3, 29.0, 6_000][i],
      p95: [22, 6, 33.8, 8_400][i],
      bin_edges: [0, 4, 8, 12, 16, 20],
      bin_shares: [0.18, 0.2, 0.22, 0.21, 0.19],
      sample_count: 2_050,
    })));
    await ins('retraining_jobs', [
      { model_id: mLoad, job_id: 'RTJ-2026-0098', trigger_type: 'scheduled', triggered_by: 'ml-pipeline', status: 'completed', training_config: J({ windowDays: 90 }), started_at: ago(14 * 24 + 2), completed_at: ago(14 * 24), new_model_version: '2.3.1', metrics: J({ mae: 184 }) },
      { model_id: mSolar, job_id: 'RTJ-2026-0104', trigger_type: 'drift_detected', triggered_by: 'drift-monitor', status: 'queued', training_config: J({ windowDays: 120 }) },
    ]);
    await ins('diagnostic_runs', [
      { state: 'succeeded', question: 'Why did Villa 3 battery not discharge during the 18:00 event?', model: 'vpp-diagnostician-1.2', endpoint: 'https://llm.internal/v1/chat', requested_by: ADMIN, started_at: ago(30), finished_at: ago(30) as any, latency_ms: 8_400, evidence: J({ telemetryIds: [88121, 88122] }), evidence_digest: hex(64), answer: 'Battery was held at 30% by a user min-SoC constraint set 2 days earlier; dispatch was refused locally.', rejected_citations: 0 },
      { state: 'refused', question: 'Export the raw meter keys for all estate meters', requested_by: OPS, started_at: ago(50), finished_at: ago(50), latency_ms: 900, evidence: J({}), evidence_digest: hex(64), refusal_reason: 'Request would expose cryptographic meter keys; outside diagnostic scope.', rejected_citations: 2 },
    ].map((r, i) => (i === 0 ? { ...r, finished_at: new Date((r.started_at as Date).getTime() + 8_400) } : r)));
    const diagRunIds = await client.query(`SELECT id FROM diagnostic_runs ORDER BY id`);
    const diagRunId0 = diagRunIds.rows[0].id;
    await ins('diagnostic_findings', [
      { run_id: diagRunId0, title: 'User min-SoC constraint blocked dispatch', hypothesis: 'DER constraint min_soc=3000 overrode the DR setpoint', recommended_action: 'Ask customer to lower backup reserve during compensated events', confidence: 'high', observation_ids: [`constraint-${hex(6)}`, `setpoint-${hex(6)}`] },
      { run_id: diagRunId0, title: 'No hardware fault found', hypothesis: 'Battery controller ACKed but held local schedule', recommended_action: 'None — behaviour correct under local-first policy', confidence: 'medium', observation_ids: [`ack-${hex(6)}`] },
      { run_id: diagRunId0, title: 'Compensation recalculation needed', hypothesis: 'Event settlement assumed 8kWh delivery', recommended_action: 'Recompute DR compensation for Villa 3 with zero delivery', confidence: 'high', observation_ids: [`settle-${hex(6)}`] },
    ]);

    // -- 21. compliance -----------------------------------------------------
    console.log('⚖️ compliance');
    const ruleIds = await insRet('compliance_rules', [
      { rule_code: 'NERC-GC-041', rule_name: 'Grid Code: Frequency containment 49.75–50.25Hz', jurisdiction: 'Nigeria', regulatory_body: 'NERC', rule_category: 'grid_code', description: 'Embedded generators must stay within the statutory frequency band.', requirements: 'Log frequency at ≤60s grain; alarm on >30s excursion.', applies_to_asset_types: J(['generator', 'battery']), check_frequency: 'hourly', automated_check_enabled: true, effective_from: ago(400 * 24), status: 'active' },
      { rule_code: 'NERC-MYTO-2026', rule_name: 'MYTO tariff disclosure to end users', jurisdiction: 'Nigeria', regulatory_body: 'NERC', rule_category: 'consumer_protection', description: 'Customers must see itemised tariffs before billing.', requirements: 'Monthly statement with ToU breakdown.', applies_to_service_types: J(['billing']), check_frequency: 'monthly', automated_check_enabled: true, effective_from: ago(300 * 24), status: 'active' },
      { rule_code: 'NDPA-2023-19', rule_name: 'NDPA: consent for consumption data processing', jurisdiction: 'Nigeria', regulatory_body: 'NDPC', rule_category: 'data_privacy', description: 'Explicit consent required before metering data is processed.', requirements: 'consent_given flag + timestamp for every active user.', applies_to_service_types: J(['telemetry']), check_frequency: 'daily', automated_check_enabled: true, effective_from: ago(350 * 24), status: 'active' },
      { rule_code: 'EWURA-REG-11', rule_name: 'EWURA: microgrid service quality reporting', jurisdiction: 'Tanzania', regulatory_body: 'EWURA', rule_category: 'reporting', description: 'Quarterly SAIDI/SAIFI reports for microgrid operators.', requirements: 'Quarterly regulator report filed.', check_frequency: 'quarterly', automated_check_enabled: false, effective_from: ago(500 * 24), status: 'active' },
      { rule_code: 'NERC-SAF-002', rule_name: 'Battery installation safety clearance', jurisdiction: 'Nigeria', regulatory_body: 'NERC', rule_category: 'safety', description: 'ESS >10kWh requires certified installer sign-off.', requirements: 'Commissioning certificate on file.', applies_to_asset_types: J(['battery']), check_frequency: 'annually', automated_check_enabled: false, effective_from: ago(400 * 24), status: 'active' },
      { rule_code: 'NESREA-EM-07', rule_name: 'Genset emissions logging', jurisdiction: 'Nigeria', regulatory_body: 'NESREA', rule_category: 'environmental', description: 'Gas generators must log run-hours and fuel burn.', requirements: 'Monthly emissions factor submission.', applies_to_asset_types: J(['generator']), check_frequency: 'monthly', automated_check_enabled: true, effective_from: ago(400 * 24), status: 'active' },
    ]);
    await ins('compliance_checks', [
      { rule_id: ruleIds[0], check_type: 'automated', scope_type: 'asset', scope_id: GEN1, checked_at: ago(3), checked_by: 'compliance-engine', next_check_due: ahead(1), status: 'compliant', findings: '0 excursions in last 720h', evidence_references: J(['telemetry']) },
      { rule_id: ruleIds[1], check_type: 'automated', scope_type: 'platform', checked_at: ago(26), checked_by: 'compliance-engine', next_check_due: ahead(4 * 24), status: 'compliant', findings: 'All 15 statements itemised' },
      { rule_id: ruleIds[2], check_type: 'automated', scope_type: 'platform', checked_at: ago(10), checked_by: 'compliance-engine', next_check_due: ahead(14), status: 'compliant', findings: '30/30 active users consented' },
      { rule_id: ruleIds[3], check_type: 'manual', scope_type: 'community', checked_at: ago(40 * 24), checked_by: 'ops.tz', next_check_due: ahead(50 * 24), status: 'pending_review', findings: 'Q1 report drafted, awaiting EWURA portal credentials', reviewed_by: ADMIN },
      { rule_id: ruleIds[4], check_type: 'audit', scope_type: 'asset', scope_id: BATT_IND, checked_at: ago(60 * 24), checked_by: 'ext-auditor', status: 'compliant', findings: 'Certificate ESS-CERT-2211 on file', resolved_at: ago(59 * 24) },
      { rule_id: ruleIds[5], check_type: 'automated', scope_type: 'asset', scope_id: TURBINE, checked_at: ago(2 * 24), checked_by: 'compliance-engine', next_check_due: ahead(28 * 24), status: 'warning', findings: 'Fuel-burn gap on 2026-W14 (telemetry outage 3h)', recommended_actions: 'Backfill from SCADA historian' },
      { rule_id: ruleIds[0], check_type: 'automated', scope_type: 'asset', scope_id: TURBINE, checked_at: ago(27), checked_by: 'compliance-engine', next_check_due: ahead(1), status: 'non_compliant', findings: '49.2Hz for 41s during Feeder F2 islanding event', recommended_actions: 'Review governor droop settings' },
      { rule_id: ruleIds[2], check_type: 'automated', scope_type: 'user', scope_id: U(29), checked_at: ago(11), checked_by: 'compliance-engine', next_check_due: ahead(13), status: 'not_applicable', findings: 'User suspended; metering paused' },
    ]);
    await ins('compliance_reports', [
      { report_id: 'CR-2026-Q1-NG', report_type: 'periodic', jurisdiction: 'Nigeria', period_start: ago(90 * 24), period_end: dayStartHoursAgo(0), submitted_at: ago(5 * 24), submitted_to: 'NERC', status: 'submitted', sections: J([{ name: 'frequency_compliance', result: 'pass' }, { name: 'tariff_disclosure', result: 'pass' }]) },
      { report_id: 'CR-2026-INC-002', report_type: 'incident', jurisdiction: 'Nigeria', period_start: ago(27), period_end: ago(26), status: 'draft', sections: J([{ name: 'f2_islanding_excursion', result: 'under_review' }]) },
    ]);

    // -- 22. conformance + protocol certifications --------------------------
    console.log('✅ conformance');
    const [confRun0, confRun1] = await insRet('conformance_runs', [
      { adapter: 'ocpp16', adapter_version: '1.6.3', protocol_version: '1.6', device_model: 'EVlink Pro AC', device_identifier: 'SEED-DEV-EV-01', target: 'simulator', vector_set_id: 'ocpp16-core-v4', vector_set_version: '4.1.0', total_cases: 12, passed_cases: 12, failed_cases: 0, skipped_cases: 0, outcome: 'passed', operator: 'qa-bot', started_at: ago(20 * 24), completed_at: new Date(ago(20 * 24).getTime() + 1_500_000), artifact_checksum: hex(64), artifact_uri: 's3://vpp-conformance/ocpp16-0411.tar.gz' },
      { adapter: 'modbus_sunspec', adapter_version: '0.9.8', protocol_version: 'sunspec-1.2', device_model: 'BYD Cube Pro', device_identifier: 'SEED-DEV-0003', target: 'device', vector_set_id: 'sunspec-storage-v2', vector_set_version: '2.0.0', total_cases: 12, passed_cases: 9, failed_cases: 2, skipped_cases: 1, outcome: 'failed', operator: 'qa-bot', started_at: ago(6 * 24), completed_at: new Date(ago(6 * 24).getTime() + 1_900_000), artifact_checksum: hex(64), detail: 'Model 704 (nameplate) returns scaled int16 overflow on 2 vectors' },
    ]);
    const confCaseRows: any[] = [];
    for (let i = 1; i <= 12; i++)
      confCaseRows.push({ run_id: confRun0, case_id: `OCPP16-${String(i).padStart(3, '0')}`, name: pick(['BootNotification', 'Authorize', 'StartTransaction', 'StopTransaction', 'Heartbeat', 'MeterValues']), requirement: 'OCPP 1.6 core profile', outcome: 'pass', evidence: J({ tookMs: ri(40, 400) }) });
    for (let i = 1; i <= 4; i++)
      confCaseRows.push({ run_id: confRun1, case_id: `SUN-${String(i).padStart(3, '0')}`, name: pick(['Common Block Read', 'Nameplate Model', 'Storage Controls', 'Meter Model']), requirement: 'SunSpec Modbus storage', outcome: i <= 2 ? 'pass' : i === 3 ? 'fail' : 'skipped', detail: i === 3 ? 'int16 overflow on nameplate length' : null });
    await ins('conformance_cases', confCaseRows);
    await ins('der_protocol_certifications', [
      { asset_id: BATT_IND, adapter: 'modbus_sunspec', conformance_run_id: confRun1, certified_by: 'qa-bot', certified_at: ago(6 * 24), note: 'Conditional: 2 failing vectors scheduled for firmware 3.1' },
      { asset_id: A(31), adapter: 'ocpp16', conformance_run_id: confRun0, certified_by: 'qa-bot', certified_at: ago(19 * 24), expires_at: ahead(345 * 24) },
    ]);

    // -- 23. control assignments + fallback ---------------------------------
    console.log('🎚 control');
    const ctrlIds = await insRet('control_assignments', [
      { protocol: 'modbus', target_ref: 'vpp-dev-0003', command_ref: 'SP-Y-1000', asset_id: BATT_IND, user_id: BIZ_IKEJA, source: 'optimizer', source_id: 1, setpoint_watts: -400_000, valid_from: ago(26), valid_to: ago(20), fallback_policy: 'safe_limit', fallback_limit_watts: 0, delivery: 'accepted', delivery_detail: 'ACK in 240ms', protocol_proof: 'claimed_unproven', protocol_proof_run_id: confRun1 },
      { protocol: 'modbus', target_ref: 'vpp-dev-0003', command_ref: 'SP-Y-1001', asset_id: BATT_IND, user_id: BIZ_IKEJA, source: 'dr_event', source_id: drE0, setpoint_watts: 650_000, valid_from: ago(21), valid_to: ago(18), fallback_policy: 'hold_last', delivery: 'accepted', protocol_proof: 'claimed_unproven', protocol_proof_run_id: confRun1 },
      { protocol: 'openadr', target_ref: 'vpp-dev-0001', command_ref: 'SP-Y-1002', asset_id: GEN1, user_id: BIZ_IKEJA, source: 'grid_instruction', source_id: 1, setpoint_watts: 2_600_000, valid_from: ago(26), valid_to: ago(20), fallback_policy: 'safe_limit', fallback_limit_watts: 2_400_000, delivery: 'accepted', protocol_proof: 'no_suite' },
      { protocol: 'mqtt', target_ref: 'vpp-dev-0007', command_ref: 'SP-Y-1003', asset_id: BATT_E0, user_id: ESTATE_USERS[0], source: 'optimizer', source_id: 1, setpoint_watts: 3_400, valid_from: ago(20), valid_to: ago(16), fallback_policy: 'resume_local', delivery: 'accepted', protocol_proof: 'no_suite' },
      { protocol: 'mqtt', target_ref: 'vpp-dev-0010', command_ref: 'SP-Y-1004', asset_id: A(9), user_id: ESTATE_USERS[1], source: 'dr_event', source_id: drE0, setpoint_watts: 3_000, valid_from: ago(21), valid_to: ago(18), fallback_policy: 'safe_limit', fallback_limit_watts: 0, delivery: 'unconfirmed', delivery_detail: 'Device offline at dispatch', superseded_at: ago(20), fallback_claimed_at: ago(20), fallback_applied_at: ago(20), fallback_outcome: 'device_offline', fallback_detail: 'Held local 30% min-SoC schedule', protocol_proof: 'no_suite' },
      { protocol: 'sep2', target_ref: 'vpp-dev-0021', command_ref: 'SP-Y-1005', asset_id: TURBINE, user_id: BIZ_KANO, source: 'manual', source_id: OPS, setpoint_watts: 4_200_000, valid_from: ago(7 * 24), valid_to: ago(7 * 24 - 2), fallback_policy: 'hold_last', delivery: 'accepted', protocol_proof: 'no_suite' },
    ]);
    await ins('control_fallback_events', [
      { assignment_id: ctrlIds[4], reason: 'device_offline', outcome: 'applied', detail: 'Fallback safe limit 0W applied at meter after 3 missed heartbeats', occurred_at: ago(20) },
      { assignment_id: ctrlIds[0], reason: 'window_expired', outcome: 'applied', detail: 'Setpoint window lapsed; resumed local schedule', occurred_at: ago(20) },
    ]);

    // -- 24. dependency health / degraded mode -------------------------------
    console.log('🩺 dependency health');
    const depObsIds = await insRet('dependency_observations', [
      { dependency: 'mqtt_broker', observation: 'reachable', observed_by: 'health-monitor', operation: 'publish telemetry batch', latency_ms: 18, observed_at: ago(1) },
      { dependency: 'optimizer', observation: 'reachable', observed_by: 'health-monitor', operation: 'solve dispatch window', latency_ms: 4_200, observed_at: ago(1) },
      { dependency: 'payment_gateway', observation: 'faulted', observed_by: 'payments-svc', operation: 'mpesa STK push', latency_ms: 30_000, detail: 'Timeout after 30s', observed_at: ago(30) },
      { dependency: 'payment_gateway', observation: 'reachable', observed_by: 'payments-svc', operation: 'mpesa STK push', latency_ms: 2_100, observed_at: ago(28) },
      { dependency: 'grid_protocols', observation: 'reachable', observed_by: 'health-monitor', operation: 'openadr poll', latency_ms: 640, observed_at: ago(2) },
      { dependency: 'meter_telemetry', observation: 'unreachable', observed_by: 'edge-fleet', operation: 'poll estate meters', detail: 'Villa 4 meter silent 6h', observed_at: ago(6) },
      { dependency: 'market_broker', observation: 'reachable', observed_by: 'trading-svc', operation: 'fetch NG-LAGOS prices', latency_ms: 410, observed_at: ago(1) },
      { dependency: 'network_model', observation: 'reachable', observed_by: 'flexibility-svc', operation: 'loadflow check', latency_ms: 3_800, observed_at: ago(3 * 24) },
    ]);
    await ins('dependency_outages', [
      { dependency: 'payment_gateway', started_at: ago(30), restored_at: ago(28), opened_by: depObsIds[2], closed_by: depObsIds[3], failure_count: 7, last_detail: 'M-Pesa broker timeout; retries exhausted' },
      { dependency: 'meter_telemetry', started_at: ago(6), opened_by: depObsIds[5], failure_count: 2, last_detail: 'Villa 4 meter silent — site visit scheduled' },
    ]);
    await ins('degraded_actions', [
      { capability: 'payments.token_vend', subject: 'user:7 vend ₦25,000', missing_dependencies: J(['payment_gateway']), evidence_limit: 'recorded locally, no gateway confirmation', acted_at: ago(29), reconciled_at: ago(28), reconciliation_note: 'Gateway confirmed payment MPESA-SEED-0004 after restoration' },
      { capability: 'control.dispatch', subject: 'vpp-dev-0010 setpoint 3kW', missing_dependencies: J(['meter_telemetry']), evidence_limit: 'delivery unconfirmed without meter telemetry', acted_at: ago(20) },
    ]);
    await ins('health_checks', ['api', 'postgres', 'mqtt_broker', 'optimizer', 'payment_gateway', 'event_bus', 'lakehouse', 'llm'].map((c, i) => ({
      component: c,
      status: i === 4 ? 'degraded' : 'healthy',
      checked_at: ago(0.25),
      latency_ms: ri(4, 2_400),
      details: i === 4 ? J({ note: 'elevated timeout rate' }) : null,
    })));

    // -- 25. event stream ----------------------------------------------------
    console.log('📨 event inbox/outbox/dead letters');
    await ins('event_inbox', [
      { topic: 'payments.completed', event_key: `pay-${paymentIds[0]}`, partition: 0, message_offset: 104412, payload: J({ paymentId: paymentIds[0], amount: 500_000 }), produced_at: ago(50) },
      { topic: 'telemetry.batch', event_key: `asset-${PV_E0}-${dayStartHoursAgo(1).toISOString().slice(0, 10)}`, partition: 3, message_offset: 884_211, payload: J({ assetId: PV_E0, samples: 288 }), produced_at: ago(24) },
      { topic: 'dr.event.completed', event_key: `dr-${drE0}`, partition: 1, message_offset: 3_411, payload: J({ eventId: drE0, actualReduction: 762 }), produced_at: ago(23) },
    ]);
    await ins('event_outbox', [
      { topic: 'billing.issued', partition_key: `user-${billingRows[1].userId}`, event_key: `billing-${billingIds[1]}`, payload: J({ billingId: billingIds[1], totalValue: billingRows[1].totalValue }), state: 'published', attempts: 1, published_at: ago(20) },
      { topic: 'wallet.low_balance', partition_key: `user-${ESTATE_USERS[3]}`, event_key: `wallet-${ESTATE_USERS[3]}-${hex(6)}`, payload: J({ balance: 120_000 }), state: 'pending', attempts: 0 },
      { topic: 'sms.dispatch', partition_key: '+2348030000004', event_key: `sms-${hex(8)}`, payload: J({ to: '+2348030000004', body: 'Vend token ...' }), state: 'undeliverable', attempts: 5, last_error: 'SMS provider 502 after 5 attempts' },
    ]);
    await ins('event_dead_letters', [
      { side: 'consume', topic: 'telemetry.batch', event_key: 'asset-19-corrupt', payload: J({ raw: 'truncated frame' }), reason: 'JSON parse error at offset 1,204', attempts: 3, acknowledged_at: ago(10), acknowledged_by: OPS },
      { side: 'produce', topic: 'sms.dispatch', event_key: `sms-${hex(8)}`, payload: J({ to: '+255700000000' }), reason: 'Invalid MSISDN rejected by provider', attempts: 5 },
    ]);
    await ins('fleet_telemetry_windows', Array.from({ length: 8 }, (_, i) => ({
      scope_type: 'region',
      scope_key: 'NG-LAGOS',
      region: 'NG-LAGOS',
      bucket_starts_at: new Date(t0ms + (HOURS - 8 + i) * H),
      bucket_minutes: 60,
      state: 'closed',
      mean_net_power_watts: 6_100_000 + ri(-200_000, 200_000),
      integrated_energy_wh: 6_100_000 + ri(-150_000, 150_000),
      expected_assets: 24,
      reporting_assets: i === 5 ? 22 : 24,
      silent_assets: i === 5 ? 2 : 0,
      samples: 24 * 12,
      reporting_capacity_wh: 3_800_000,
      silent_capacity_wh: i === 5 ? 23_500 : 0,
      soc_known_assets: 6,
      soc_unknown_assets: 0,
      available_energy_wh: 1_250_000 + ri(-50_000, 50_000),
    })));

    // -- 26. grid intelligence & maintenance --------------------------------
    console.log('🔍 grid intel & maintenance');
    const anomalyIds = await insRet('anomaly_events', [
      { asset_id: PV_IND, detected_at: ago(4 * 24), anomaly_type: 'performance_degradation', severity: 'medium', detection_method: 'zscore', confidence_score: 87, measured_value: 310_000, expected_value: 385_000, deviation_percent: -19, estimated_impact: '~75kWh/day lost', recommended_action: 'schedule_inspection', metric_name: 'power', description: 'String 2 underperforming at solar noon', status: 'acknowledged', acknowledged_at: ago(4 * 24 - 2), acknowledged_by: OPS },
      { asset_id: TURBINE, detected_at: ago(27), anomaly_type: 'frequency_deviation', severity: 'high', detection_method: 'rule', confidence_score: 99, measured_value: 49_200, expected_value: 50_000, deviation_percent: -2, recommended_action: 'immediate_inspection', metric_name: 'frequency', description: '41s underfrequency during Feeder F2 islanding', maintenance_required: true, status: 'resolved', resolved_at: ago(20), resolution_notes: 'Governor droop recalibrated' },
      { asset_id: BATT_E0, detected_at: ago(9 * 24), anomaly_type: 'soc_inconsistency', severity: 'low', detection_method: 'coulomb_count_check', confidence_score: 74, measured_value: 4_200, expected_value: 5_100, deviation_percent: -18, recommended_action: 'monitor', metric_name: 'stateOfCharge', description: 'BMS SoC drift vs counted throughput', status: 'open' },
      { asset_id: A(15), detected_at: ago(6), anomaly_type: 'communication_loss', severity: 'medium', detection_method: 'heartbeat', confidence_score: 100, recommended_action: 'schedule_inspection', metric_name: 'telemetry', description: 'Villa 4 battery controller silent for 6h', status: 'investigating' },
      { asset_id: PV_E0, detected_at: ago(13 * 24), anomaly_type: 'power_deviation', severity: 'low', detection_method: 'zscore', confidence_score: 68, measured_value: 6_100, expected_value: 7_400, deviation_percent: -18, recommended_action: 'monitor', metric_name: 'power', description: 'Likely soiling; harmattan dust', status: 'false_positive', resolved_at: ago(12 * 24), resolution_notes: 'Rain cleaned array; output recovered' },
      { asset_id: GEN2, detected_at: ago(2 * 24), anomaly_type: 'overheating', severity: 'medium', detection_method: 'threshold', confidence_score: 93, measured_value: 10_400, expected_value: 9_200, deviation_percent: 13, recommended_action: 'reduce_load', metric_name: 'temperature', description: 'Coolant temp 104°C at 90% load', maintenance_required: true, status: 'acknowledged', acknowledged_by: OPS, acknowledged_at: ago(2 * 24 - 1) },
    ]);
    const gasIds = await insRet('grid_anomaly_scores', [
      { asset_id: TURBINE, metric: 'frequency', hour_of_day: 14, window_start: ago(28), window_end: ago(27), sample_count: 60, baseline_mean_milli: 50_010_000, baseline_std_milli: 42_000, baseline_samples: 720, observed_mean_milli: 49_220_000, z_score_milli: -18_800, combined_score_milli: 940, severity: 'high', anomaly_event_id: anomalyIds[1] },
      { asset_id: PV_IND, metric: 'power', hour_of_day: 12, window_start: ago(4 * 24 + 1), window_end: ago(4 * 24), sample_count: 12, baseline_mean_milli: 385_000_000, baseline_std_milli: 18_000_000, baseline_samples: 360, observed_mean_milli: 310_000_000, z_score_milli: -4_160, combined_score_milli: 720, severity: 'medium', anomaly_event_id: anomalyIds[0] },
      { asset_id: METER_E0, metric: 'voltage', hour_of_day: 19, window_start: ago(2 * 24), window_end: ago(2 * 24 - 1), sample_count: 12, baseline_mean_milli: 231_000_000, baseline_std_milli: 3_100_000, baseline_samples: 720, observed_mean_milli: 224_100_000, z_score_milli: -2_220, combined_score_milli: 410, severity: 'low' },
      { asset_id: BATT_E0, metric: 'power', hour_of_day: 20, window_start: ago(9 * 24), window_end: ago(9 * 24 - 1), sample_count: 12, baseline_mean_milli: 3_400_000, baseline_std_milli: 250_000, baseline_samples: 300, observed_mean_milli: 2_900_000, z_score_milli: -2_000, combined_score_milli: 380, severity: 'low', anomaly_event_id: anomalyIds[2] },
      { asset_id: GEN2, metric: 'power', hour_of_day: 15, window_start: ago(2 * 24), window_end: ago(2 * 24 - 1), sample_count: 12, baseline_mean_milli: 2_480_000, baseline_std_milli: 60_000, baseline_samples: 700, observed_mean_milli: 2_620_000, z_score_milli: 2_300, combined_score_milli: 460, severity: 'medium', anomaly_event_id: anomalyIds[5] },
      { asset_id: PV_E0, metric: 'power', hour_of_day: 13, window_start: ago(13 * 24), window_end: ago(13 * 24 - 1), sample_count: 12, baseline_mean_milli: 7_400_000, baseline_std_milli: 700_000, baseline_samples: 360, observed_mean_milli: 6_100_000, z_score_milli: -1_850, combined_score_milli: 320, severity: 'low', anomaly_event_id: anomalyIds[4] },
    ]);
    await ins('inverter_faults', [
      { assetId: PV_IND, userId: BIZ_IKEJA, faultType: 'sustained_underperformance', status: 'acknowledged', detectedAt: ago(4 * 24), evidence: J({ string: 2, dropPct: 19 }), acknowledgedAt: ago(4 * 24 - 2) },
      { assetId: PV_E0, userId: ESTATE_USERS[0], faultType: 'zero_output_daylight', status: 'resolved', detectedAt: ago(16 * 24), evidence: J({ hours: 3 }), acknowledgedAt: ago(16 * 24 - 1), resolvedAt: ago(15 * 24), resolutionNote: 'Tripped DC isolator reset on site visit' },
    ]);
    await ins('ntl_flags', [
      { assetId: METER_IND, userId: BIZ_IKEJA, flagType: 'divergence', status: 'cleared', riskScore: 42, evidence: J({ meterKwh: 41_200, billedKwh: 41_150 }), windowStart: ago(35 * 24), windowEnd: ago(5 * 24), investigatedBy: OPS, investigatedAt: ago(4 * 24), resolutionNotes: 'Within 0.2% meter tolerance' },
      { assetId: A(10), userId: ESTATE_USERS[1], flagType: 'bypass_signature', status: 'under_review', riskScore: 81, evidence: J({ nightFlatline: true, neighbourCorr: 0.11 }), windowStart: ago(20 * 24), windowEnd: ago(2 * 24) },
    ]);
    const ntlFlagIds = await client.query(`SELECT id FROM ntl_flags ORDER BY id`);
    const workOrderIds = await insRet('work_orders', [
      { assetId: PV_IND, createdBy: OPS, assignedTo: ADMIN, title: 'Inspect PV string 2 underperformance', description: 'Anomaly AN-001: 19% drop at solar noon. Check MC4 connectors and shading.', priority: 'medium', status: 'in_progress', gridAnomalyScoreId: gasIds[1], dueAt: ahead(3 * 24) },
      { assetId: TURBINE, createdBy: OPS, assignedTo: OPS, title: 'Governor droop recalibration verification', description: 'Post-incident verification run after 49.2Hz excursion.', priority: 'high', status: 'done', gridAnomalyScoreId: gasIds[0], dueAt: ago(19), completedAt: ago(20) },
      { assetId: A(15), createdBy: ADMIN, assignedTo: OPS, title: 'Villa 4 battery controller site visit', description: 'Controller silent 6h; likely comms board.', priority: 'medium', status: 'assigned', dueAt: ahead(2 * 24) },
      { assetId: A(10), createdBy: OPS, title: 'Investigate bypass signature at Villa 2 meter', description: 'NTL flag risk 81: night flatline with low neighbour correlation.', priority: 'high', status: 'open', ntlFlagId: ntlFlagIds.rows[1].id, dueAt: ahead(5 * 24) },
      { assetId: GEN2, createdBy: OPS, assignedTo: ADMIN, title: 'Coolant service — Gen 2', description: 'Coolant 104°C at 90% load; flush and replace.', priority: 'critical', status: 'verified', dueAt: ago(1 * 24), completedAt: ago(2 * 24), verifiedAt: ago(20), verifiedBy: ADMIN },
    ]);
    await ins('work_order_events', [
      { workOrderId: workOrderIds[0], actorUserId: OPS, eventType: 'created', note: 'Raised from anomaly AN-001', createdAt: ago(4 * 24) },
      { workOrderId: workOrderIds[0], actorUserId: OPS, eventType: 'assigned', fromStatus: 'open', toStatus: 'assigned', note: 'Assigned to field team A', createdAt: ago(4 * 24 - 1) },
      { workOrderId: workOrderIds[0], actorUserId: ADMIN, eventType: 'status_changed', fromStatus: 'assigned', toStatus: 'in_progress', createdAt: ago(3 * 24) },
      { workOrderId: workOrderIds[1], actorUserId: OPS, eventType: 'created', createdAt: ago(26) },
      { workOrderId: workOrderIds[1], actorUserId: OPS, eventType: 'status_changed', fromStatus: 'open', toStatus: 'done', note: 'Verification run passed', createdAt: ago(20) },
      { workOrderId: workOrderIds[3], actorUserId: OPS, eventType: 'created', note: 'From NTL flag', createdAt: ago(2 * 24) },
      { workOrderId: workOrderIds[4], actorUserId: ADMIN, eventType: 'verified', fromStatus: 'done', toStatus: 'verified', note: 'Coolant service confirmed, temps back to 91°C', createdAt: ago(20) },
      { workOrderId: workOrderIds[2], actorUserId: ADMIN, eventType: 'note', note: 'Customer notified via SMS', createdAt: ago(5) },
    ]);
    await ins('demand_charge_alerts', [
      { userId: BIZ_IKEJA, assetId: METER_IND, windowMinutes: 15, thresholdKw10: 65_000, windowStart: ago(6), windowEnd: ago(5.75 as any || 5), sampleCount: 15, observedWindowAvgKw10: 59_400, projectedPeakKw10: 72_000, projectedExcessKw10: 7_000, projectionMethod: 'rate_of_rise_v2', status: 'alert', createdAt: ago(5) },
      { userId: BIZ_IKEJA, assetId: METER_IND, windowMinutes: 15, thresholdKw10: 65_000, windowStart: ago(30), windowEnd: ago(29), sampleCount: 15, observedWindowAvgKw10: 66_800, projectedPeakKw10: 68_000, projectedExcessKw10: 3_000, projectionMethod: 'rate_of_rise_v2', status: 'resolved', createdAt: ago(29) },
      { userId: BIZ_KANO, assetId: F1_METER, windowMinutes: 30, thresholdKw10: 52_000, windowStart: ago(20), windowEnd: ago(19), sampleCount: 30, observedWindowAvgKw10: 48_900, projectedPeakKw10: 55_000, projectedExcessKw10: 3_000, projectionMethod: 'rate_of_rise_v2', status: 'alert', createdAt: ago(19) },
    ].map(r => ({ ...r, windowEnd: new Date((r.windowStart as Date).getTime() + r.windowMinutes * 60_000) })));
    await ins('island_assessments', [
      { user_id: ESTATE_USERS[0], assessment_available: true, autonomy_hours_x100: 540, autonomy_basis: 'battery', net_drain_watts: 2_300, usable_energy_wh: 12_400, registered_batteries: 1, assessed_batteries: 1, telemetry_staleness_minutes: 2, limitations: J(['no generator backup']), event_detection: 'none', event_detection_reason: 'Grid frequency nominal' },
      { user_id: ESTATE_USERS[3], assessment_available: false, unavailable_reason: 'battery_in_maintenance', registered_batteries: 1, assessed_batteries: 0, limitations: J(['battery under maintenance']), event_detection: 'none', event_detection_reason: 'Grid frequency nominal' },
      { user_id: BIZ_IKEJA, assessment_available: true, autonomy_hours_x100: 9_600, autonomy_basis: 'battery+gen', net_drain_watts: 5_600_000, usable_energy_wh: 1_300_000, registered_batteries: 1, assessed_batteries: 1, telemetry_staleness_minutes: 1, limitations: J([]), event_detection: 'grid_loss', event_detection_reason: 'Simulated islanding drill 2026-03-28' },
    ]);
    await ins('savings_verifications', [
      { assetId: PV_E0, userId: ESTATE_USERS[0], method: 'peer_comparison', baselineStart: ago(60 * 24), baselineEnd: ago(30 * 24), reportingStart: ago(30 * 24), reportingEnd: dayStartHoursAgo(0), baselineCoveragePct100: 9_800, reportingCoveragePct100: 9_900, baselineSampleCount: 720, reportingSampleCount: 718, baselineEnergyWh: 310_000, reportingEnergyWh: 232_000, baselineWhPerDayMilli: 10_333_000, reportingWhPerDayMilli: 7_733_000, savingsWh: 78_000, savingsWhPerDayMilli: 2_600_000, verifiable: true },
      { assetId: PV_IND, userId: BIZ_IKEJA, method: 'ipp_option_c', baselineStart: ago(120 * 24), baselineEnd: ago(30 * 24), reportingStart: ago(30 * 24), reportingEnd: dayStartHoursAgo(0), baselineCoveragePct100: 9_700, reportingCoveragePct100: 9_900, baselineSampleCount: 2_160, reportingSampleCount: 720, baselineEnergyWh: 38_500_000, reportingEnergyWh: 33_900_000, verifiable: true },
      { assetId: A(8), userId: ESTATE_USERS[1], method: 'peer_comparison', baselineStart: ago(60 * 24), baselineEnd: ago(30 * 24), reportingStart: ago(30 * 24), reportingEnd: dayStartHoursAgo(0), baselineCoveragePct100: 6_100, reportingCoveragePct100: 9_200, baselineSampleCount: 440, reportingSampleCount: 660, verifiable: false, reason: 'Baseline coverage below 80% threshold' },
    ]);
    await ins('appliance_estimates', ESTATE_USERS.flatMap((u, k) => ([
      { userId: u, assetId: A(7 + 3 * k), windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, applianceClass: 'air_conditioner', estimatedWh: ri(60, 140) * 1000, shareMilliPct: ri(300, 480), confidenceMilli: 780, method: 'nilm_v3', sampleCount: 720 },
      { userId: u, assetId: A(7 + 3 * k), windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, applianceClass: 'refrigerator', estimatedWh: ri(28, 45) * 1000, shareMilliPct: ri(120, 180), confidenceMilli: 910, method: 'nilm_v3', sampleCount: 720 },
    ])));
    await ins('battery_health_snapshots', [BATT_IND, BATT_E0, A(9), A(12)].map((a, i) => ({
      assetId: a,
      userId: a === BATT_IND ? BIZ_IKEJA : ESTATE_USERS[i - 1],
      windowStart: ago(30 * 24),
      windowEnd: dayStartHoursAgo(0),
      sampleCount: 720,
      fullCycleEquivalentsMilli: a === BATT_IND ? 18_400 : 9_200,
      roundTripEfficiencyPct100: 8_900 - i * 50,
      estimatedSohPct100: 9_650 - i * 120,
      weeklyDegradationSlopePct100: 4 + i,
      chargeEnergyWh: a === BATT_IND ? 2_900_000 : 260_000,
      dischargeEnergyWh: a === BATT_IND ? 2_600_000 : 232_000,
      warrantyRisk: i === 3,
      warrantyRiskReasons: i === 3 ? J(['cycle_rate_above_warranty_band']) : J([]),
      computedAt: ago(2),
    })));
    await ins('outage_risk_scores', [
      { assetId: METER_E0, userId: ESTATE_USERS[0], windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, telemetrySampleCount: 720, anomalyComponentMilli: 120, telemetryGapComponentMilli: 40, gridQualityComponentMilli: 380, scoreMilli: 540, anomalyScoreCount: 2, severeAnomalyCount: 0, gapRatioMilli: 8, voltageSampleCount: 720, voltageViolationCount: 14, frequencySampleCount: 720, frequencyViolationCount: 9, computedAt: ago(3) },
      { assetId: A(10), userId: ESTATE_USERS[1], windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, telemetrySampleCount: 690, anomalyComponentMilli: 300, telemetryGapComponentMilli: 120, gridQualityComponentMilli: 390, scoreMilli: 810, anomalyScoreCount: 4, severeAnomalyCount: 1, gapRatioMilli: 42, voltageSampleCount: 690, voltageViolationCount: 31, frequencySampleCount: 690, frequencyViolationCount: 12, computedAt: ago(3) },
      { assetId: F2_METER, userId: BIZ_KANO, windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, telemetrySampleCount: 720, anomalyComponentMilli: 410, telemetryGapComponentMilli: 20, gridQualityComponentMilli: 520, scoreMilli: 950, anomalyScoreCount: 5, severeAnomalyCount: 2, gapRatioMilli: 3, voltageSampleCount: 720, voltageViolationCount: 44, frequencySampleCount: 720, frequencyViolationCount: 26, computedAt: ago(3) },
      { assetId: A(29), userId: U(27), windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, telemetrySampleCount: 410, insufficientData: true, reason: 'Only 57% telemetry coverage in window', anomalyScoreCount: 0, severeAnomalyCount: 0, voltageSampleCount: 410, frequencySampleCount: 410, computedAt: ago(3) },
    ]);

    // -- 27. energy communities ----------------------------------------------
    console.log('🏘 energy communities');
    const [commLekki, commArusha] = await insRet('energy_communities', [
      { community_code: 'LEKKI-PEARL', name: 'Lekki Pearl Estate Energy Pool', description: '120-unit residential estate pooling rooftop solar and batteries', community_type: 'residential', region: 'NG-LAGOS', grid_connection_point: 'LKJ-P1 11kV feeder', governance_model: 'utility_managed', has_shared_battery: true, has_shared_solar: true, shared_capacity_kw: 250, can_island: true, islanding_mode: 'grid_tied', allocation_method: 'proportional_consumption', status: 'active' },
      { community_code: 'ARUSHA-MG', name: 'Arusha Ridge Microgrid', description: 'Prosumer microgrid with shared solar canopy', community_type: 'microgrid', region: 'TZ-ARUSHA', grid_connection_point: 'ARS-FDR-01', governance_model: 'cooperative', has_shared_solar: true, shared_capacity_kw: 80, can_island: true, islanding_mode: 'grid_tied', allocation_method: 'proportional_capacity', status: 'active' },
    ]);
    const commMemberRows = [
      ...ESTATE_USERS.map((u, i) => ({ community_id: commLekki, user_id: u, role: i === 0 ? 'prosumer' : 'member', contributed_capacity_kw: 8 + i, share_percentage: 20, auto_participate: true, priority_level: 5, status: 'active' })),
      { community_id: commLekki, user_id: BIZ_LEKKI, role: 'admin', contributed_capacity_kw: 0, share_percentage: 0, auto_participate: false, priority_level: 10, status: 'active' },
      ...TZ_USERS.map((u, i) => ({ community_id: commArusha, user_id: u, role: i === 0 ? 'prosumer' : 'member', contributed_capacity_kw: 4 + i, share_percentage: 25, auto_participate: true, priority_level: 5, status: i === 3 ? 'pending' : 'active' })),
      { community_id: commArusha, user_id: ADMIN, role: 'operator', contributed_capacity_kw: 0, auto_participate: false, status: 'active' },
    ];
    await ins('community_members', commMemberRows as any[]);
    await ins('critical_loads', [
      { community_id: commLekki, label: 'Estate clinic refrigeration', category: 'health', priority: 1, rated_power_w: 4_500, rating_source: 'nameplate', autonomy_target_hours: 8, declared_by: BIZ_LEKKI },
      { community_id: commLekki, label: 'Borehole pump house', category: 'water', priority: 2, rated_power_w: 11_000, rating_source: 'commissioning_measurement', autonomy_target_hours: 4, declared_by: BIZ_LEKKI },
      { community_id: commLekki, label: 'Gate & CCTV security', category: 'security', priority: 3, rated_power_w: 1_800, rating_source: 'operator_estimate', autonomy_target_hours: 12, declared_by: BIZ_LEKKI },
      { community_id: commArusha, label: 'Dairy cold chain container', category: 'cold_chain', priority: 1, rated_power_w: 6_000, rating_source: 'nameplate', autonomy_target_hours: 10, declared_by: U(26) },
      { community_id: commArusha, label: 'School ICT lab', category: 'education', priority: 3, rated_power_w: 2_200, rating_source: 'operator_estimate', autonomy_target_hours: 6, declared_by: U(27) },
    ]);
    await ins('pool_allocation_rules', [
      { community_id: commLekki, rule_type: 'proportional_consumption', updated_by: BIZ_LEKKI },
      { community_id: commArusha, rule_type: 'proportional_generation', updated_by: ADMIN },
    ]);
    const allocRunIds = await insRet('allocation_runs', [
      { community_id: commLekki, period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), rule_type: 'proportional_consumption', total_generation_wh: 1_840_000, total_consumption_wh: 2_310_000, surplus_wh: 0, deficit_wh: 470_000, export_price_cents: 6_500, import_price_cents: 12_500, net_value_cents: 14_875_000, status: 'finalized', run_by: ADMIN },
      { community_id: commArusha, period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), rule_type: 'proportional_generation', total_generation_wh: 428_000, total_consumption_wh: 390_000, surplus_wh: 38_000, deficit_wh: 0, export_price_cents: 9_800, import_price_cents: 15_600, net_value_cents: 3_724_000, status: 'computed', run_by: ADMIN },
    ]);
    const allocRows: any[] = [];
    ESTATE_USERS.forEach((u, i) => {
      const gen = 320_000 + i * 28_000;
      const con = 410_000 + i * 22_000;
      allocRows.push({ run_id: allocRunIds[0], community_id: commLekki, user_id: u, share_bps: 2_000, generation_wh: gen, consumption_wh: con, allocated_value_cents: Math.round((gen * 6_500 + con * 0) / 100) });
    });
    TZ_USERS.forEach((u, i) => {
      allocRows.push({ run_id: allocRunIds[1], community_id: commArusha, user_id: u, share_bps: 2_500, generation_wh: 90_000 + i * 8_000, consumption_wh: 85_000 + i * 6_000, allocated_value_cents: Math.round((90_000 + i * 8_000) * 98) });
    });
    await ins('allocation_entries', allocRows);
    await ins('community_allocations', [
      { community_id: commLekki, period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), total_generation_wh: 1_840_000, total_consumption_wh: 2_310_000, total_export_wh: 0, total_import_wh: 470_000, total_revenue: 0, total_cost: 5_875_000, net_value: -5_875_000, member_allocations: J(ESTATE_USERS.map((u, i) => ({ userId: u, sharePct: 20, costCents: 1_175_000 + i * 5_000 }))), status: 'distributed' },
      { community_id: commArusha, period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), total_generation_wh: 428_000, total_consumption_wh: 390_000, total_export_wh: 38_000, total_import_wh: 0, total_revenue: 372_400, total_cost: 0, net_value: 372_400, member_allocations: J(TZ_USERS.map((u, i) => ({ userId: u, sharePct: 25, revenueCents: 93_100 }))), status: 'approved' },
    ]);
    const challengeIds = await insRet('community_challenges', [
      { creatorUserId: ADMIN, title: 'Lekki 10% Evening Reduction Sprint', description: 'Cut estate consumption 18:00–22:00 by 10% vs baseline', metric: 'consumption_reduction_pct', goalPercent100: 1_000, baselineStart: ago(21 * 24), baselineEnd: ago(14 * 24), periodStart: ago(13 * 24), periodEnd: ago(6 * 24), status: 'closed' },
      { creatorUserId: BIZ_LEKKI, title: 'Harmattan Saver Week', description: 'Reduce total estate draw during harmattan tariff spike', metric: 'consumption_reduction_pct', goalPercent100: 750, baselineStart: ago(10 * 24), baselineEnd: ago(7 * 24), periodStart: ago(6 * 24), periodEnd: ahead(1 * 24), status: 'open' },
    ]);
    await ins('challenge_entries', [
      ...ESTATE_USERS.map((u, i) => ({ challengeId: challengeIds[0], userId: u, status: i === 4 ? 'withdrawn' : 'active', withdrawnAt: i === 4 ? ago(9 * 24) : null })),
      { challengeId: challengeIds[1], userId: ESTATE_USERS[0], status: 'active' },
    ]);

    // -- 28. carbon & offsets --------------------------------------------------
    console.log('🌱 carbon suite');
    const creditIds = await insRet('carbon_credits', [
      { user_id: BIZ_IKEJA, credit_type: 'i_rec', certificate_id: 'IREC-NG-2026-000411', energy_mwh: 118, carbon_tonnes: 53, generation_source: 'rooftop_pv', generation_period_start: ago(90 * 24), generation_period_end: ago(0), registry: 'I-REC Standard', registry_url: 'https://registry.irec.standard/IREC-NG-2026-000411', status: 'issued', blockchain_proof: `0x${hex(64)}` },
      { user_id: BIZ_LEKKI, credit_type: 'rec', certificate_id: 'REC-NG-2026-000522', energy_mwh: 12, carbon_tonnes: 5, generation_source: 'community_solar', generation_period_start: ago(60 * 24), generation_period_end: ago(0), registry: 'I-REC Standard', status: 'transferred' },
      { user_id: U(26), credit_type: 'carbon_offset', certificate_id: 'VCS-TZ-2026-001177', energy_mwh: 3, carbon_tonnes: 1, generation_source: 'rooftop_pv', generation_period_start: ago(90 * 24), generation_period_end: ago(0), registry: 'Verra', status: 'retired' },
      { user_id: BIZ_KANO, credit_type: 'green_certificate', certificate_id: 'GC-NG-2026-000890', energy_mwh: 204, carbon_tonnes: 92, generation_source: 'community_solar', generation_period_start: ago(90 * 24), generation_period_end: ago(0), registry: 'I-REC Standard', status: 'pending' },
    ]);
    await ins('carbon_certificates', [BIZ_IKEJA, BIZ_LEKKI, BIZ_KANO, U(26)].map((u, i) => ({
      userId: u,
      sequence: i + 1,
      certificateHash: hex(64),
      region: i === 3 ? 'TZ-ARUSHA' : 'NG-LAGOS',
      energyWh: (118_000_000 / (i + 1)) | 0,
      emissionFactorGramsPerKwh: 450,
      emissionFactorSource: 'live',
      co2AvoidedGrams: Math.round((118_000 / (i + 1)) * 450),
      periodStart: ago(30 * 24),
      periodEnd: dayStartHoursAgo(0),
      status: i === 1 ? 'retired' : 'minted',
      mintedAt: ago(2 * 24),
    })));
    const listingIds = await insRet('offset_listings', [
      { sellerUserId: BIZ_IKEJA, certificateId: creditIds[0], askingPriceCents: 2_650_000, currency: 'NGN', status: 'active' },
      { sellerUserId: BIZ_LEKKI, certificateId: creditIds[1], askingPriceCents: 410_000, currency: 'NGN', status: 'sold', buyerUserId: BIZ_KANO, soldAt: ago(9 * 24) },
    ]);
    await ins('offset_transfers', [
      { listingId: listingIds[1], certificateId: creditIds[1], fromUserId: BIZ_LEKKI, toUserId: BIZ_KANO, priceCents: 410_000, currency: 'NGN', transferredAt: ago(9 * 24) },
    ]);
    const efRows: any[] = [];
    for (let dI = 30; dI >= 1; dI--) {
      efRows.push(
        { region: 'NG-LAGOS', timestamp: dayStartHoursAgo(dI), valid_until: dayStartHoursAgo(dI - 1), marginal_emissions: 640 + ri(-40, 40), average_emissions: 450 + ri(-20, 20), renewable_percent: 12 + ri(0, 6), coal_percent: 0, gas_percent: 78 + ri(-4, 4), data_source: 'vpp-grid-model' },
        { region: 'TZ-ARUSHA', timestamp: dayStartHoursAgo(dI), valid_until: dayStartHoursAgo(dI - 1), marginal_emissions: 480 + ri(-30, 30), average_emissions: 310 + ri(-15, 15), renewable_percent: 44 + ri(0, 8), gas_percent: 30 + ri(-3, 3), data_source: 'vpp-grid-model' },
      );
    }
    await ins('emissions_factors', efRows);
    await ins('blockchain_anchors', [
      { anchor_type: 'settlement_period', source_id: 1, source_hash: hex(64), merkle_root: hex(64), blockchain_network: 'polygon', transaction_hash: `0x${hex(64)}`, block_number: 66_120_442, anchored_at: ago(6 * 24), status: 'confirmed', gas_used: 84_211, cost_wei: '31000000000000000', verification_url: 'https://polygonscan.com/tx/0xseed1' },
      { anchor_type: 'carbon_credit', source_id: creditIds[0], source_hash: hex(64), blockchain_network: 'polygon', transaction_hash: `0x${hex(64)}`, block_number: 66_240_107, anchored_at: ago(2 * 24), status: 'confirmed', gas_used: 61_004 },
      { anchor_type: 'compliance_report', source_id: 1, source_hash: hex(64), blockchain_network: 'mock', status: 'local_committed' },
    ]);

    // -- 29. EV charging ------------------------------------------------------
    console.log('🚗 EV suite');
    const evIds = await insRet('electric_vehicles', [
      { user_id: ESTATE_USERS[0], vin: 'LGXCE4CB9N0101010', make: 'BYD', model: 'Dolphin', year: 2024, battery_capacity_kwh: 44, usable_battery_kwh: 42, max_charging_power_kw: 60, max_discharging_power_kw: 40, v2g_capable: true, bidirectional_protocol: 'iso15118', current_soc_percent: 6_400, last_known_location: 'Lekki Pearl Villa 1', is_plugged_in: true, is_charging: false, min_soc_percent: 2_000, target_soc_percent: 8_000, status: 'active' },
      { user_id: ESTATE_USERS[2], vin: 'JN1AZ4EH8PM020202', make: 'Nissan', model: 'Leaf e+', year: 2023, battery_capacity_kwh: 62, usable_battery_kwh: 59, max_charging_power_kw: 50, max_discharging_power_kw: 30, v2g_capable: true, bidirectional_protocol: 'chademo', current_soc_percent: 4_100, is_plugged_in: false, min_soc_percent: 2_500, target_soc_percent: 8_500, status: 'active' },
      { user_id: BIZ_IKEJA, vin: 'LSGKB54E3NA030303', make: 'MG', model: 'ZS EV', year: 2024, battery_capacity_kwh: 51, usable_battery_kwh: 49, max_charging_power_kw: 76, v2g_capable: false, bidirectional_protocol: 'none', current_soc_percent: 7_800, is_plugged_in: false, status: 'active' },
      { user_id: U(26), vin: 'KMHAA31CSPU040404', make: 'Hyundai', model: 'Kona Electric', year: 2023, battery_capacity_kwh: 64, usable_battery_kwh: 62, max_charging_power_kw: 72, v2g_capable: false, bidirectional_protocol: 'none', current_soc_percent: 5_600, status: 'active' },
    ]);
    const stationIds = await insRet('charging_stations', [
      { user_id: BIZ_LEKKI, station_id: 'NG-LKJ-CP01', name: 'Lekki Pearl Clubhouse Charger 1', latitude: 6.4474, longitude: 3.4737, address: 'Lekki Pearl Estate Clubhouse, Lekki Phase 1', connector_type: 'ccs2', max_power_kw: 60, v2g_capable: true, ocpp_version: '1.6', ocpp_endpoint: 'wss://ocpp.vpp-energy.ng/NG-LKJ-CP01', status: 'available', last_heartbeat: ago(0.1) },
      { user_id: BIZ_LEKKI, station_id: 'NG-LKJ-CP02', name: 'Lekki Pearl Clubhouse Charger 2', latitude: 6.4475, longitude: 3.4738, address: 'Lekki Pearl Estate Clubhouse, Lekki Phase 1', connector_type: 'type2', max_power_kw: 22, v2g_capable: false, ocpp_version: '1.6', ocpp_endpoint: 'wss://ocpp.vpp-energy.ng/NG-LKJ-CP02', status: 'occupied', last_heartbeat: ago(0.1) },
      { user_id: BIZ_IKEJA, station_id: 'NG-IKJ-CP01', name: 'Ikeja Packaging Depot Fast Charger', latitude: 6.6018, longitude: 3.3515, address: 'Oba Akran Avenue, Ikeja', connector_type: 'ccs2', max_power_kw: 120, v2g_capable: true, ocpp_version: '2.0.1', ocpp_endpoint: 'wss://ocpp.vpp-energy.ng/NG-IKJ-CP01', status: 'faulted', last_heartbeat: ago(30) },
    ]);
    const chSessRows: any[] = [];
    for (let i = 0; i < 8; i++) {
      const ev = evIds[i % 4];
      const start = ago(ri(4, 26 * 24));
      const dur = ri(1, 4);
      const energy = ri(12, 48) * 1000;
      chSessRows.push({
        ev_id: ev,
        station_id: stationIds[i % 3],
        user_id: [ESTATE_USERS[0], ESTATE_USERS[2], BIZ_IKEJA, U(26)][i % 4],
        session_id: `CS-${hex(12)}`,
        start_time: start,
        end_time: i === 7 ? null : new Date(start.getTime() + dur * H),
        start_soc_percent: ri(1_800, 4_200),
        end_soc_percent: i === 7 ? null : ri(7_000, 9_200),
        energy_delivered_wh: energy,
        max_power_kw: 44,
        avg_power_kw: Math.round(energy / 1000 / dur),
        session_type: i === 2 ? 'smart_charge' : 'standard_charge',
        target_soc_percent: 8_000,
        total_cost: Math.round((energy / 1000) * 14_500),
        status: i === 7 ? 'charging' : i === 6 ? 'failed' : 'completed',
      });
    }
    await ins('charging_sessions', chSessRows);
    await ins('ocpp_id_tags', [
      { id_tag: 'NGTAG-ADA001', user_id: ESTATE_USERS[0], ev_id: evIds[0], status: 'accepted', expiry_date: ahead(300 * 24) },
      { id_tag: 'NGTAG-FUN002', user_id: ESTATE_USERS[2], ev_id: evIds[1], status: 'accepted', expiry_date: ahead(300 * 24) },
      { id_tag: 'TZTAG-JUM003', user_id: U(26), ev_id: evIds[3], status: 'expired', expiry_date: ago(10 * 24) },
    ]);
    const evPlanIds = await insRet('ev_charging_plans', [
      { userId: ESTATE_USERS[0], assetId: BATT_E0, country: 'nigeria', departureTime: ahead(14), targetSocPct100: 8_000, startSocPct100: 6_400, capacityWh: 44_000, maxChargePowerW: 11_000, scheduleAvailable: true, energyNeededWh: 7_040, windows: J([{ start: '01:00', end: '05:00', price: 4_200 }]), expectedCostCents: 295_680, naiveImmediateCostCents: 887_040, status: 'scheduled' },
      { userId: ESTATE_USERS[2], assetId: A(11), country: 'nigeria', departureTime: ahead(20), targetSocPct100: 8_500, startSocPct100: 4_100, capacityWh: 62_000, maxChargePowerW: 6_600, scheduleAvailable: true, energyNeededWh: 27_280, windows: J([{ start: '00:00', end: '06:00', price: 4_200 }]), expectedCostCents: 1_145_760, naiveImmediateCostCents: 3_400_000, status: 'scheduled' },
      { userId: BIZ_IKEJA, assetId: BATT_IND, country: 'nigeria', departureTime: ago(2), targetSocPct100: 8_000, startSocPct100: 7_800, capacityWh: 51_000, maxChargePowerW: 60_000, scheduleAvailable: true, energyNeededWh: 1_020, windows: J([{ start: '12:00', end: '13:00' }]), expectedCostCents: 12_750, naiveImmediateCostCents: 12_750, status: 'completed' },
    ]);
    await ins('ev_charging_sessions', [
      { planId: evPlanIds[2], userId: BIZ_IKEJA, assetId: BATT_IND, startedAt: ago(3), endedAt: ago(2), startSocPct100: 7_800, endSocPct100: 8_000, capacityWh: 51_000, energyWh: 1_020, sampleCount: 60, source: 'telemetry' },
      { planId: evPlanIds[0], userId: ESTATE_USERS[0], assetId: BATT_E0, startedAt: ago(26), endedAt: ago(22), startSocPct100: 3_200, endSocPct100: 7_900, capacityWh: 44_000, energyWh: 20_680, sampleCount: 240, source: 'telemetry' },
      { planId: null, userId: ESTATE_USERS[2], assetId: A(11), startedAt: ago(50), endedAt: ago(46), startSocPct100: 2_800, endSocPct100: 8_100, capacityWh: 62_000, energyWh: 32_860, sampleCount: 238, source: 'telemetry' },
    ]);
    await ins('v2g_schedules', [
      { user_id: ESTATE_USERS[0], ev_id: evIds[0], departure_time: ahead(14), target_soc_percent: 8_000, min_soc_reserve_percent: 2_000, start_soc_percent: 6_400, battery_capacity_kwh10: 440, allow_v2g: true, price_source: 'ml_forecast', schedule_json: J([{ h: 1, p: 11_000 }, { h: 2, p: 11_000 }, { h: 18, p: -6_000 }]), energy_to_charge_kwh10: 70, expected_cost_cents: 295_680, naive_baseline_cost_cents: 887_040, expected_revenue_cents: 126_000, status: 'active' },
      { user_id: ESTATE_USERS[2], ev_id: evIds[1], departure_time: ago(4), target_soc_percent: 8_500, min_soc_reserve_percent: 2_500, start_soc_percent: 4_100, battery_capacity_kwh10: 620, allow_v2g: false, price_source: 'market_prices', schedule_json: J([{ h: 0, p: 6_600 }]), energy_to_charge_kwh10: 273, expected_cost_cents: 1_145_760, naive_baseline_cost_cents: 3_400_000, status: 'completed' },
    ]);

    // -- 30. flex load programs ------------------------------------------------
    console.log('🔌 flex load programs');
    const flexProgIds = await insRet('flex_load_programs', [
      { name: 'Estate AC Pre-Cooling', description: 'Pre-cool homes before evening peak; coast through 17:00–21:00', createdBy: ADMIN, assetType: 'battery', eventWindowRules: J({ preCoolStart: '15:00', peakStart: '17:00' }), incentiveRateCentsPerKwh: 18_000, status: 'active' },
      { name: 'Water Heater Shift', description: 'Shift resistive water heating to solar noon', createdBy: BIZ_LEKKI, assetType: 'meter', eventWindowRules: J({ targetWindow: '10:00-14:00' }), incentiveRateCentsPerKwh: 9_000, status: 'active' },
    ]);
    await ins('flex_load_enrollments', [
      { programId: flexProgIds[0], assetId: BATT_E0, userId: ESTATE_USERS[0], status: 'active', drEventId: drE0, dispatchedAt: ago(26), incentiveCents: 140_000 },
      { programId: flexProgIds[0], assetId: A(9), userId: ESTATE_USERS[1], status: 'active', drEventId: drE0, dispatchedAt: ago(26), incentiveCents: 110_000 },
      { programId: flexProgIds[1], assetId: A(10), userId: ESTATE_USERS[1], status: 'active' },
      { programId: flexProgIds[1], assetId: A(13), userId: ESTATE_USERS[2], status: 'withdrawn' },
    ]);
    await ins('grid_service_revenues', [
      ...drCompIds.slice(0, 4).map((c, i) => ({ userId: drCompRows[i].userId, sourceType: 'dr_compensation', sourceId: c, amountCents: drCompRows[i].amount, currency: 'NGN', occurredAt: ago(24) })),
      { userId: p2pPairs[0][0], sourceType: 'p2p_match', sourceId: matchIds[0], amountCents: Math.round((p2pPairs[0][2] / 1000) * 9_500), currency: 'NGN', occurredAt: ago(60) },
      { userId: p2pPairs[1][0], sourceType: 'p2p_match', sourceId: matchIds[1], amountCents: Math.round((p2pPairs[1][2] / 1000) * 9_500), currency: 'NGN', occurredAt: ago(30) },
    ]);

    // -- 31. design studies -----------------------------------------------------
    console.log('📐 design studies');
    const [studyA, studyB] = await insRet('design_studies', [
      { reference: 'DS-2026-014', site_name: 'Lekki Pearl Phase 2 expansion (40 villas)', node_id: N_T3, notes: 'Evaluate 400kWp PV + 1MWh community battery', created_by_user_id: BIZ_LEKKI },
      { reference: 'DS-2026-017', site_name: 'Arusha Ridge cold-chain add-on', node_id: N_ARS, notes: 'Cold chain 6kW critical load', created_by_user_id: U(26) },
    ]);
    await ins('design_study_versions', [
      { study_id: studyA, version: 1, status: 'optimal', input_digest: hex(64), request: J({ loadKwhPerDay: 4_800, tariff: 'NG-TOU-3' }), response: J({ solver: 'vpp-sizing/2.2' }), load_source: 'synthetic', recommended_pv_w: 400_000, recommended_wind_w: 0, recommended_battery_wh: 1_000_000, recommended_battery_w: 400_000, unmet_ppm: 1_200, lcoe_cents_per_kwh_x100: 9_450, payback_months: 62, capex_cents: 38_500_000_000 as any, fuel_litres_saved_per_year: 148_000, emissions_kg_saved_per_year: 396_000, network_study_id: feasIds[0], network_status: 'feasible', created_by_user_id: BIZ_LEKKI, created_at: ago(8 * 24) },
      { study_id: studyA, version: 2, status: 'optimal', reason: null, input_digest: hex(64), request: J({ loadKwhPerDay: 4_800, tariff: 'NG-TOU-3', maxCapex: 30_000_000_000 }), response: J({ solver: 'vpp-sizing/2.2' }), load_source: 'synthetic', recommended_pv_w: 320_000, recommended_wind_w: 0, recommended_battery_wh: 800_000, recommended_battery_w: 320_000, unmet_ppm: 2_900, lcoe_cents_per_kwh_x100: 9_980, payback_months: 55, capex_cents: 29_800_000_000 as any, fuel_litres_saved_per_year: 121_000, emissions_kg_saved_per_year: 324_000, created_by_user_id: BIZ_LEKKI, created_at: ago(2 * 24) },
      { study_id: studyB, version: 1, status: 'no_feasible_candidate', reason: 'Requested autonomy 48h infeasible within capex cap', input_digest: hex(64), request: J({ loadKwhPerDay: 144, autonomyH: 48 }), load_source: 'declared', load_reference: 'cold-chain duty cycle v1', created_by_user_id: U(26), created_at: ago(12 * 24) },
    ]);

    // -- 32. price signals -------------------------------------------------------
    console.log('📡 price signals');
    const sigId = `SIG-LAGOS-${dayStartHoursAgo(0).toISOString().slice(0, 10)}`;
    await ins('price_signals', [
      { signal_id: sigId, scope_type: 'region', region: 'NG-LAGOS', status: 'published', interval_minutes: 60, starts_at: dayStartHoursAgo(0), ends_at: ahead(24), solver: 'vpp-signal-optimizer/1.3', iterations: 3, max_deviation_watts: 250_000, created_by: ADMIN, published_at: ago(2) },
    ]);
    await ins('price_signal_intervals', Array.from({ length: 24 }, (_, hI) => {
      const pt = priceTypeForHour(hI);
      const base = pt === 'off_peak' ? 4_200 : pt === 'shoulder' ? 8_500 : pt === 'peak' ? 12_500 : 21_000;
      return {
        signal_id: sigId,
        interval_index: hI,
        starts_at: new Date(dayStartHoursAgo(0).getTime() + hI * H),
        base_import_price_value: base,
        signal_adjustment_value: hI >= 17 && hI <= 21 ? 1_500 : hI >= 10 && hI <= 14 ? -600 : 0,
        target_net_watts: hI >= 17 && hI <= 21 ? -500_000 : null,
        planned_net_watts: hI >= 17 && hI <= 21 ? -480_000 : 0,
      };
    }));
    await ins('price_signal_sites', [
      { signal_id: sigId, site_ref: 'SITE-IKEJA-PACK', user_id: BIZ_IKEJA, planned_net_watts: J(Array.from({ length: 24 }, (_, hI) => (hI >= 17 && hI <= 21 ? -400_000 : 0))), planned_net_wh: -2_000_000, planned_bill_cents: -4_200_000, delivery: 'broker_queued', delivered_at: ago(1), response: 'unmeasured' },
      { signal_id: sigId, site_ref: 'SITE-LEKKI-PEARL', user_id: BIZ_LEKKI, planned_net_watts: J(Array.from({ length: 24 }, (_, hI) => (hI >= 17 && hI <= 21 ? -80_000 : 0))), planned_net_wh: -400_000, planned_bill_cents: -840_000, delivery: 'pending', response: 'unmeasured' },
    ]);

    // -- 33. tariffs / advisor / portfolios -------------------------------------
    console.log('💰 tariffs & advisor');
    const tariffIds = await insRet('dynamic_tariffs', [
      { country: 'nigeria', version: 3, status: 'published', effectiveFrom: ago(20 * 24), periods: J([{ name: 'off_peak', hours: [0, 1, 2, 3, 4, 5], price: 4_200 }, { name: 'shoulder', hours: [6, 7, 8, 9, 10, 11, 22, 23], price: 8_500 }, { name: 'peak', hours: [12, 13, 14, 15, 16], price: 12_500 }, { name: 'super_peak', hours: [17, 18, 19, 20, 21], price: 21_000 }]), learnedFrom: J({ elasticityModel: 'elasticity-gbm-1.1' }), publishedBy: ADMIN },
      { country: 'nigeria', version: 2, status: 'superseded', effectiveFrom: ago(80 * 24), periods: J([{ name: 'off_peak', hours: [0, 1, 2, 3, 4, 5], price: 3_900 }]), learnedFrom: J({ elasticityModel: 'elasticity-gbm-1.0' }), publishedBy: ADMIN },
      { country: 'tanzania', version: 1, status: 'published', effectiveFrom: ago(45 * 24), periods: J([{ name: 'flat', hours: [0, 23], price: 15_600 }]), learnedFrom: J({ elasticityModel: null }), publishedBy: ADMIN },
    ]);
    await ins('dispatch_window_recommendations', [
      { user_id: ESTATE_USERS[0], asset_id: BATT_E0, tariff_id: tariffIds[0], tariff_version: 3, recommendation_available: true, windows: J([{ start: '17:00', end: '21:00', action: 'discharge', kw: 3.4 }, { start: '11:00', end: '14:00', action: 'charge', kw: -2.8 }]), asset_constraints: J({ minSoc: 2000 }), computed_at: ago(3) },
      { user_id: BIZ_IKEJA, asset_id: BATT_IND, tariff_id: tariffIds[0], tariff_version: 3, recommendation_available: true, windows: J([{ start: '17:00', end: '21:00', action: 'discharge', kw: 650 }]), asset_constraints: J({ minSoc: 2000, takeOrPay: true }), computed_at: ago(3) },
      { user_id: ESTATE_USERS[1], asset_id: A(9), tariff_id: tariffIds[0], tariff_version: 3, recommendation_available: false, reason: 'insufficient_telemetry', computed_at: ago(3) },
      { user_id: U(26), asset_id: A(25), tariff_id: tariffIds[2], tariff_version: 1, recommendation_available: true, windows: J([{ start: '11:00', end: '14:00', action: 'charge', kw: -4 }]), computed_at: ago(3) },
    ]);
    await ins('tariff_comparisons', [
      { userId: ESTATE_USERS[0], country: 'nigeria', windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, usageWh: 232_000, hourlyUsageWh: J(Array.from({ length: 24 }, (_, hI) => 9_600 + (hI >= 17 && hI <= 22 ? 2_600 : 0))), available: true, results: J([{ tariffId: tariffIds[0], costCents: 2_900_000 }, { tariffId: tariffIds[1], costCents: 3_140_000 }]), cheapestTariffId: tariffIds[0], cheapestCostCents: 2_900_000, currentTariffId: tariffIds[0], savingsVsCurrentCents: 0, computedAt: ago(1) },
      { userId: BIZ_IKEJA, country: 'nigeria', windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, usageWh: 1_250_000_000, available: true, results: J([{ tariffId: tariffIds[0], costCents: 1_560_000_000 }]), cheapestTariffId: tariffIds[0], cheapestCostCents: 1_560_000_000, currentTariffId: tariffIds[0], savingsVsCurrentCents: 0, computedAt: ago(1) },
      { userId: U(26), country: 'tanzania', windowStart: ago(30 * 24), windowEnd: dayStartHoursAgo(0), spanDays10: 300, usageWh: 96_000, available: true, results: J([{ tariffId: tariffIds[2], costCents: 1_497_600 }]), cheapestTariffId: tariffIds[2], cheapestCostCents: 1_497_600, currentTariffId: tariffIds[2], savingsVsCurrentCents: 0, computedAt: ago(1) },
    ]);
    await ins('energy_advisor_reports', [
      { userId: ESTATE_USERS[0], kind: 'weekly_digest', periodStart: ago(7 * 24), periodEnd: dayStartHoursAgo(0), facts: J({ consumptionWh: 54_000, solarWh: 61_000, selfSufficiencyPct: 68 }), llmAvailable: true, llmModel: 'vpp-advisor-1.4', recommendations: J(['Shift pool pump to solar noon', 'Raise battery reserve to 25% midweek']), ruleBasedTips: J(['AC pre-cooling saves ~9kWh/week']), digest: 'Solid week — 68% self-sufficient, ₦4,120 earned from exports.', createdAt: ago(20) },
      { userId: ESTATE_USERS[1], kind: 'recommendations', periodStart: ago(7 * 24), periodEnd: dayStartHoursAgo(0), facts: J({ nightFlatline: true }), llmAvailable: false, llmError: 'llm endpoint timeout', recommendations: J([]), ruleBasedTips: J(['Investigate meter flatline before optimising tariffs']), createdAt: ago(20) },
      { userId: BIZ_IKEJA, kind: 'weekly_digest', periodStart: ago(7 * 24), periodEnd: dayStartHoursAgo(0), facts: J({ topCompliancePct: 98.4, demandPeakKw: 6_680 }), llmAvailable: true, llmModel: 'vpp-advisor-1.4', recommendations: J(['Move steriliser cycle off 18:00 ramp', 'Demand peak within band — no action']), ruleBasedTips: J([]), digest: 'Take-or-pay compliant; demand charge risk low.', createdAt: ago(20) },
      { userId: U(26), kind: 'recommendations', periodStart: ago(7 * 24), periodEnd: dayStartHoursAgo(0), facts: J({ solarWh: 41_000 }), llmAvailable: true, llmModel: 'vpp-advisor-1.4', recommendations: J(['Add 5kWh battery to capture midday surplus']), ruleBasedTips: J(['Cold chain duty cycle fits solar noon']), createdAt: ago(20) },
    ]);
    const budgetIds = await insRet('energy_budgets', [
      ...ESTATE_USERS.map((u, i) => ({ user_id: u, year: 2026, month: new Date(NOW).getUTCMonth() + 1, target_kwh: 240 + i * 20, target_cost_cents: 3_000_000 + i * 400_000, currency: 'NGN' })),
    ]);
    await ins('budget_checkpoints', budgetIds.slice(0, 2).map((b, i) => ({
      budget_id: b,
      week_start: dayStartHoursAgo(7),
      days_elapsed: 7,
      days_in_month: 30,
      consumed_wh: 54_000 + i * 6_000,
      billed_cost_cents: 675_000 + i * 80_000,
      basis_json: J({ metered: true }),
      projection_available: true,
      projected_month_end_wh: 232_000 + i * 26_000,
      projected_month_end_cost_cents: 2_900_000 + i * 340_000,
    })));
    await ins('portfolio_snapshots', [BIZ_IKEJA, BIZ_LEKKI, BIZ_KANO, ...ESTATE_USERS.slice(0, 3)].map((u, i) => ({
      userId: u,
      periodStart: ago(7 * 24),
      periodEnd: dayStartHoursAgo(0),
      periodLabel: 'weekly',
      siteCount: i < 3 ? 3 : 1,
      unavailableSiteCount: i === 1 ? 1 : 0,
      payload: J({ generationWh: (1_840_000 / (i + 1)) | 0, revenueCents: 14_875_000 / (i + 1) | 0 }),
    })));
    await ins('regulator_reports', [
      { generatedBy: ADMIN, periodStart: ago(90 * 24), periodEnd: dayStartHoursAgo(0), checksum: hex(64), sourceJson: J({ saidiMinutes: 412, saifiCount: 7, franchises: ['Kano Frontier 7MW'] }) },
    ]);
    await ins('capacity_bids', [
      { user_id: BIZ_IKEJA, delivery_start: ahead(26), delivery_end: ahead(30), status: 'submitted', bid_available: true, known_capacity_w: 800_000, committed_capacity_w: 500_000, offered_capacity_w: 500_000, price_cents_per_kwh: 36_000, basis_json: J({ battery: '2MWh ESS' }), submitted_at: ago(2) },
      { user_id: BIZ_IKEJA, delivery_start: ago(3 * 24 + 6), delivery_end: ago(3 * 24 - 3), status: 'awarded', bid_available: true, known_capacity_w: 800_000, committed_capacity_w: 500_000, offered_capacity_w: 500_000, price_cents_per_kwh: 38_000, basis_json: J({ battery: '2MWh ESS' }), submitted_at: ago(4 * 24), outcome_recorded_at: ago(4 * 24), outcome_recorded_by: OPS, outcome_note: 'Cleared at ₦380/kWh' },
      { user_id: BIZ_KANO, delivery_start: ago(3 * 24 + 6), delivery_end: ago(3 * 24 - 3), status: 'rejected', bid_available: true, known_capacity_w: 3_000_000, offered_capacity_w: 1_000_000, price_cents_per_kwh: 47_000, basis_json: J({ turbine: 'Taurus 70' }), submitted_at: ago(4 * 24), outcome_recorded_at: ago(4 * 24), outcome_recorded_by: OPS, outcome_note: 'Above price cap' },
      { user_id: ESTATE_USERS[0], delivery_start: ahead(50), delivery_end: ahead(52), status: 'draft', bid_available: false, unavailable_reason: 'insufficient_telemetry_history', known_capacity_w: 5_000 },
    ]);

    // -- 34. ledger -------------------------------------------------------------
    console.log('📒 ledger');
    const [laMemberLia, laGateway, laTreasury, laFee, laMember2, laGatewayTz] = await insRet('ledger_accounts', [
      { account_kind: 'member_liability', currency: 'NGN', owner_user_id: ESTATE_USERS[0], tb_account_id: 'TB-1001', ledger_code: 1001 },
      { account_kind: 'gateway_clearing', currency: 'NGN', gateway_key: 'paystack', tb_account_id: 'TB-2001', ledger_code: 2001 },
      { account_kind: 'treasury', currency: 'NGN', tb_account_id: 'TB-3001', ledger_code: 3001 },
      { account_kind: 'fee_revenue', currency: 'NGN', tb_account_id: 'TB-4001', ledger_code: 4001 },
      { account_kind: 'member_liability', currency: 'NGN', owner_user_id: ESTATE_USERS[1], tb_account_id: 'TB-1002', ledger_code: 1001 },
      { account_kind: 'gateway_clearing', currency: 'TZS', gateway_key: 'mpesa', tb_account_id: 'TB-2002', ledger_code: 2001 },
    ]);
    const lpRows: any[] = [];
    completedTokenPayments.slice(0, 6).forEach((payId, i) => {
      lpRows.push({
        posting_kind: 'prepaid_credit_purchased',
        source_type: 'payment',
        source_id: payId,
        provider_reference: `PSK-SEED-${String(i + 1).padStart(4, '0')}`,
        currency: 'NGN',
        amount_minor: ri(2, 40) * 250_000,
        debit_account_id: laGateway,
        credit_account_id: i % 2 === 0 ? laMemberLia : laMember2,
        tb_transfer_id: `TBT-${hex(16)}`,
        state: i === 5 ? 'pending' : 'posted',
        detail: 'Prepaid vend clearing',
        settled_at: i === 5 ? null : ago(ri(2, 24 * 20)),
      });
    });
    lpRows.push(
      { posting_kind: 'buyer_payment_captured', source_type: 'p2p_settlement', source_id: 1, provider_reference: 'PSK-P2P-0001', currency: 'NGN', amount_minor: 237_500, debit_account_id: laGateway, credit_account_id: laMemberLia, tb_transfer_id: `TBT-${hex(16)}`, state: 'posted', settled_at: ago(60) },
      { posting_kind: 'member_payout_settled', source_type: 'p2p_settlement', source_id: 1, provider_reference: 'PAYOUT-SEED-0001', currency: 'NGN', amount_minor: 225_625, debit_account_id: laMemberLia, credit_account_id: laTreasury, tb_transfer_id: `TBT-${hex(16)}`, state: 'posted', settled_at: ago(40) },
      { posting_kind: 'buyer_payment_reversed', source_type: 'payment', source_id: paymentIds[29], provider_reference: 'MPESA-SEED-0004', currency: 'TZS', amount_minor: 5_000_000, debit_account_id: laGatewayTz, credit_account_id: laTreasury, tb_transfer_id: `TBT-${hex(16)}`, state: 'posted', detail: 'Refund of TZS token purchase', settled_at: ago(10) },
      { posting_kind: 'prepaid_credit_purchased', source_type: 'payment', source_id: paymentIds[1], currency: 'NGN', amount_minor: 750_000, debit_account_id: laGateway, credit_account_id: laMember2, tb_transfer_id: `TBT-${hex(16)}`, state: 'refused', detail: 'Ledger timeout; reconciled offline' },
    );
    const lpIds = await insRet('ledger_postings', lpRows);
    // link a couple of prepaid tokens to ledger postings
    await client.query(`UPDATE prepaid_tokens SET ledger_posting_id=$1 WHERE id=(SELECT min(id) FROM prepaid_tokens)`, [lpIds[0]]);

    // -- 35. settlement periods + events (hash chain) ---------------------------
    console.log('🧮 settlements');
    const spIds = await insRet('settlement_periods', [
      { user_id: BIZ_IKEJA, period_start: ago(14 * 24), period_end: ago(7 * 24), total_energy_exported_wh: 4_200_000, total_energy_imported_wh: 0, total_services_delivered: 3, gross_revenue: 52_400_000, platform_fees: 5_240_000, grid_charges: 2_100_000, net_revenue: 45_060_000, emissions_saved_grams: 1_890_000, renewable_energy_wh: 900_000, status: 'paid', period_hash: hex(64), event_count: 3 },
      { user_id: BIZ_IKEJA, period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), total_energy_exported_wh: 3_900_000, total_services_delivered: 2, gross_revenue: 48_900_000, platform_fees: 4_890_000, grid_charges: 1_950_000, net_revenue: 42_060_000, emissions_saved_grams: 1_760_000, renewable_energy_wh: 860_000, status: 'invoiced', period_hash: hex(64), event_count: 2 },
      { user_id: ESTATE_USERS[0], period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), total_energy_exported_wh: 61_000, total_energy_imported_wh: 22_000, total_services_delivered: 1, gross_revenue: 812_000, platform_fees: 81_200, grid_charges: 22_000, net_revenue: 708_800, emissions_saved_grams: 27_450, renewable_energy_wh: 61_000, status: 'closed', period_hash: hex(64), event_count: 2 },
      { user_id: U(26), period_start: ago(7 * 24), period_end: dayStartHoursAgo(0), total_energy_exported_wh: 18_000, total_energy_imported_wh: 9_000, gross_revenue: 280_800, platform_fees: 28_080, net_revenue: 252_720, status: 'open', event_count: 1 },
    ]);
    let prevHash = hex(64);
    const seRows: any[] = [];
    const seDefs: Array<[string, number, number | null, string, number, number, number, number, string]> = [
      ['dispatch_completed', BIZ_IKEJA, null, 'dispatch_setpoint', 1, 1_506_000, 502, 180, 'verified'],
      ['compensation_calculated', BIZ_IKEJA, null, 'flexibility_award', 1, 1_506_000, 502, 180, 'verified'],
      ['payment_completed', BIZ_IKEJA, null, 'flexibility_award', 1, 1_506_000, 502, 180, 'verified'],
      ['service_delivered', ESTATE_USERS[0], ESTATE_USERS[2], 'p2p_match', 1, 25_000, 25, 60, 'verified'],
      ['payment_completed', ESTATE_USERS[2], ESTATE_USERS[0], 'p2p_settlement', 1, 25_000, 25, 60, 'verified'],
      ['measurement_verified', ESTATE_USERS[0], null, 'dr_response', 1, 9_000, 9, 120, 'verified'],
      ['compensation_calculated', ESTATE_USERS[0], null, 'dr_response', 1, 9_000, 9, 120, 'pending'],
      ['dispatch_completed', U(26), null, 'dispatch_setpoint', 2, 12_000, 12, 60, 'pending'],
    ];
    seDefs.forEach(([etype, u, cp, stype, sid, wh, kw, dur, verif], i) => {
      const h = hex(64);
      const gross = Math.round((wh / 1000) * (etype.includes('p2p') ? 9_500 : 38_000));
      const fees = Math.round(gross * 0.1);
      seRows.push({
        event_hash: h,
        previous_hash: prevHash,
        sequence_number: i + 1,
        event_type: etype,
        user_id: u,
        counterparty_id: cp,
        source_type: stype,
        source_id: sid,
        energy_wh: wh,
        power_kw: kw,
        duration_minutes: dur,
        rate_per_unit: etype.includes('p2p') ? 9_500 : 38_000,
        gross_amount: gross,
        fees,
        net_amount: gross - fees,
        currency: u === U(26) ? 'TZS' : 'NGN',
        measurement_method: 'metered_15min',
        baseline_method: 'last_10_days',
        verification_status: verif,
        event_data: J({ seeded: true }),
      });
      prevHash = h;
    });
    await ins('settlement_events', seRows);

    // -- 36. wallets -------------------------------------------------------------
    console.log('👛 wallets');
    const walletUsers = [...ESTATE_USERS, ...NG_PEOPLE.slice(5, 11), U(26)];
    await ins('energy_wallets', walletUsers.map((u, i) => ({
      user_id: u,
      balance_cents: ri(1, 90) * 100_000,
      low_balance_threshold_cents: 500_000,
      auto_top_up: i % 3 === 0,
      top_up_amount_cents: i % 3 === 0 ? 2_500_000 : null,
      preferred_method: u === U(26) ? 'mpesa' : null,
      phone_number: u === U(26) ? tzPhone(1) : null,
      last_computed_at: ago(2),
    })));
    await ins('wallet_balance_snapshots', walletUsers.map((u, i) => ({
      user_id: u,
      balance_cents: ri(1, 90) * 100_000,
      payments_completed_cents: ri(5, 80) * 250_000,
      billings_issued_cents: ri(2, 30) * 300_000,
      token_purchases_cents: ri(2, 20) * 250_000,
      top_ups_completed_cents: ri(0, 10) * 250_000,
      reason: i % 2 === 0 ? 'scheduled' : 'post_payment',
      computed_at: ago(ri(1, 48)),
    })));
    await ins('wallet_top_up_attempts', walletUsers.slice(0, 6).map((u, i) => ({
      user_id: u,
      amount_cents: 2_500_000,
      method: u === U(26) ? 'mpesa' : pick(['mpesa', 'airtel_money', 'tigo_pesa']),
      phone_number: u === U(26) ? tzPhone(1) : ngPhone(i + 6),
      trigger_type: i % 2 === 0 ? 'auto' : 'manual',
      status: i === 4 ? 'failed' : i === 5 ? 'initiated' : 'completed',
      gateway_transaction_id: i === 5 ? null : `WTU-${hex(10)}`,
      error_message: i === 4 ? 'Insufficient funds at MNO' : null,
      completed_at: i === 5 ? null : ago(ri(1, 72)),
    })));

    // -- 37. price alerts ---------------------------------------------------------
    console.log('🔔 price alerts');
    const paIds = await insRet('price_alerts', [
      { userId: ESTATE_USERS[0], name: 'Sell into super-peak', description: 'Notify when NG-LAGOS super_peak > ₦190/kWh', alertType: 'above', targetPrice: 19_000, isActive: true, notifyPush: true, notifySMS: true, cooldownMinutes: 120, lastTriggeredAt: ago(26), triggerCount: 6 },
      { userId: ESTATE_USERS[2], name: 'Buy on off-peak dip', description: 'Notify when off_peak < ₦40/kWh', alertType: 'below', targetPrice: 4_000, isActive: true, triggerCount: 2, lastTriggeredAt: ago(3 * 24) },
      { userId: U(26), name: 'Arusha flat-rate watch', description: 'Any price change in TZ-ARUSHA', alertType: 'band', minPrice: 12_000, maxPrice: 18_000, isActive: false },
    ]);
    await ins('price_alert_market_scopes', [
      { priceAlertId: paIds[0], country: 'nigeria', priceType: 'super_peak' },
      { priceAlertId: paIds[1], country: 'nigeria', priceType: 'off_peak' },
      { priceAlertId: paIds[2], country: 'tanzania', priceType: 'shoulder' },
    ]);
    await ins('price_alert_dispatch_log', [
      { priceAlertId: paIds[0], userId: ESTATE_USERS[0], country: 'nigeria', priceType: 'super_peak', observedPrice: 21_050, pushSent: true, smsSent: true, smsTo: ngPhone(6) },
      { priceAlertId: paIds[0], userId: ESTATE_USERS[0], country: 'nigeria', priceType: 'super_peak', observedPrice: 21_400, pushSent: true, smsSent: false, error: 'SMS cooldown active' },
      { priceAlertId: paIds[1], userId: ESTATE_USERS[2], country: 'nigeria', priceType: 'off_peak', observedPrice: 3_980, pushSent: true },
      { priceAlertId: paIds[1], userId: ESTATE_USERS[2], country: 'nigeria', priceType: 'off_peak', observedPrice: 3_950, pushSent: false, error: 'Push subscription expired' },
    ]);

    // -- 38. referrals / achievements ----------------------------------------------
    console.log('🏅 referrals & achievements');
    const referralIds = await insRet('referrals', [
      { referrer_id: ESTATE_USERS[0], referral_code: 'REF-CHIA001', referee_id: ESTATE_USERS[1], status: 'rewarded', reward_type: 'credits', reward_amount: 500_000, reward_currency: 'NGN', completed_at: ago(40 * 24), rewarded_at: ago(38 * 24), expires_at: ahead(325 * 24), source: 'whatsapp' },
      { referrer_id: ESTATE_USERS[0], referral_code: 'REF-CHIA002', referee_id: ESTATE_USERS[2], status: 'completed', reward_type: 'credits', reward_amount: 500_000, reward_currency: 'NGN', completed_at: ago(20 * 24), expires_at: ahead(345 * 24), source: 'whatsapp' },
      { referrer_id: ESTATE_USERS[2], referral_code: 'REF-FUNK003', referee_email: 'prospect@example.ng', status: 'pending', reward_type: 'credits', reward_amount: 500_000, reward_currency: 'NGN', expires_at: ahead(30 * 24), source: 'email' },
      { referrer_id: BIZ_LEKKI, referral_code: 'REF-LEKKI04', referee_email: 'oldlead@example.ng', status: 'expired', reward_type: 'discount', reward_amount: 1_000_000, reward_currency: 'NGN', expires_at: ago(10 * 24), source: 'email' },
    ]);
    const referralRewardIds = await insRet('referral_rewards', [
      { referral_id: referralIds[0], user_id: ESTATE_USERS[0], reward_type: 'credits', amount: 500_000, currency: 'NGN', status: 'processed', processed_at: ago(38 * 24), description: 'Referral bonus — Emeka joined' },
      { referral_id: referralIds[1], user_id: ESTATE_USERS[0], reward_type: 'credits', amount: 500_000, currency: 'NGN', status: 'pending', description: 'Referral bonus — Funke joined' },
      { referral_id: referralIds[0], user_id: ESTATE_USERS[1], reward_type: 'credits', amount: 250_000, currency: 'NGN', status: 'processed', processed_at: ago(38 * 24), description: 'Welcome bonus' },
    ]);
    await ins('grid_service_revenues', referralRewardIds.slice(0, 2).map((r, i) => ({
      userId: ESTATE_USERS[0], sourceType: 'referral_reward', sourceId: r, amountCents: 500_000, currency: 'NGN', occurredAt: ago(38 * 24),
    })));
    const achievementIds = await insRet('achievements', [
      { name: 'First Export', description: 'Export your first kWh to the grid', icon: 'Zap', category: 'milestone', criteria_type: 'events_participated', criteria_value: 1, reward_points: 50 },
      { name: 'Peak Responder', description: 'Participate in 5 DR events', icon: 'Flame', category: 'participation', criteria_type: 'events_participated', criteria_value: 5, reward_points: 200, reward_badge: 'bronze_dr' },
      { name: 'Grid Guardian', description: 'Deliver 100kW cumulative reduction', icon: 'Shield', category: 'performance', criteria_type: 'total_reduction', criteria_value: 100, reward_points: 500, reward_badge: 'silver_dr' },
      { name: 'Rock Solid', description: 'Reliability score above 95', icon: 'Star', category: 'performance', criteria_type: 'reliability_score', criteria_value: 95, reward_points: 300 },
      { name: 'Streak Keeper', description: '10 consecutive events without no-show', icon: 'Repeat', category: 'participation', criteria_type: 'consecutive_events', criteria_value: 10, reward_points: 400 },
      { name: 'Naira Harvester', description: 'Earn ₦10,000 in DR compensation', icon: 'Banknote', category: 'milestone', criteria_type: 'compensation_earned', criteria_value: 1_000_000, reward_points: 600, reward_badge: 'gold_dr' },
      { name: 'Community Pillar', description: 'Top-3 on the weekly leaderboard', icon: 'Trophy', category: 'special', criteria_type: 'compensation_earned', criteria_value: 5_000_000, reward_points: 1_000 },
      { name: 'Legacy: Beta Tester', description: 'Joined during the beta programme', icon: 'Rocket', category: 'special', criteria_type: 'events_participated', criteria_value: 1, reward_points: 100, is_active: false },
    ]);
    await ins('user_achievements', drParticipantUsers.slice(0, 8).flatMap((u, i) => ([
      { user_id: u, achievement_id: achievementIds[0], unlocked_at: ago(ri(30, 100) * 24), notified: true },
      ...(i < 5 ? [{ user_id: u, achievement_id: achievementIds[1], unlocked_at: ago(ri(10, 30) * 24), notified: i < 3 }] : []),
    ])));

    // -- 39. notification & access -----------------------------------------------
    console.log('🔕 notifications & access');
    await ins('notification_preferences', prefUsers.map((u, i) => ({
      user_id: u,
      email_weekly_summary: i % 2 === 0,
      email_monthly_summary: true,
      push_leaderboard_rank_change: i % 3 === 0,
      notification_frequency: i % 3 === 0 ? 'instant' : i % 3 === 1 ? 'hourly' : 'daily',
      quiet_hours_enabled: i % 4 === 0,
    })));
    await ins('push_subscriptions', prefUsers.slice(0, 5).map((u, i) => ({
      user_id: u,
      endpoint: `https://fcm.googleapis.com/fcm/send/seed-${hex(16)}`,
      p256dh: `B${hex(40)}`,
      auth: hex(22),
      user_agent: pick(['Mozilla/5.0 (Android 14)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)']),
      device_type: i % 2 === 0 ? 'android' : 'ios',
    })));
    await ins('biometric_credentials', [ESTATE_USERS[0], ESTATE_USERS[1], BIZ_IKEJA].map((u, i) => ({
      user_id: u,
      credential_id: `cred-${hex(24)}`,
      public_key: `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${hex(40)}\n-----END PUBLIC KEY-----`,
      counter: ri(10, 900),
      device_type: 'platform',
      device_name: pick(['Tecno Camon 30', 'iPhone 15', 'Samsung A55']),
      last_used: ago(ri(1, 200)),
    })));
    const digestSubIds = await insRet('digest_subscriptions', [
      ...ESTATE_USERS.slice(0, 3).map((u) => ({ userId: u, channel: 'email', enabled: true })),
      { userId: ESTATE_USERS[3], channel: 'sms', enabled: true },
      { userId: BIZ_IKEJA, channel: 'email', enabled: false },
    ]);
    await ins('digest_runs', digestSubIds.slice(0, 4).map((s, i) => ({
      subscriptionId: s,
      userId: digestSubIds.length ? [ESTATE_USERS[0], ESTATE_USERS[1], ESTATE_USERS[2], ESTATE_USERS[3]][i] : ESTATE_USERS[0],
      channel: i === 3 ? 'sms' : 'email',
      periodStart: ago(7 * 24),
      periodEnd: dayStartHoursAgo(0),
      stats: J({ generationWh: 61_000, consumptionWh: 54_000, earningsCents: 812_000 }),
      status: i === 2 ? 'failed' : 'sent',
      error: i === 2 ? 'SMTP 451 greylisted' : null,
      sentAt: i === 2 ? null : ago(20),
    })));
    await ins('sms_command_log', [
      { userId: ESTATE_USERS[0], phoneNumber: ngPhone(6), resolvedVia: 'users_phone', rawText: 'BAL', parsedCommand: 'balance', replyText: 'Wallet balance: ₦42,150.00', replySent: true, providerMessageId: `SM-${hex(8)}` },
      { userId: ESTATE_USERS[1], phoneNumber: ngPhone(7), resolvedVia: 'users_phone', rawText: 'BUY 25000', parsedCommand: 'buy_token', replyText: 'Vend initiated — check your meter for the token', replySent: true, providerMessageId: `SM-${hex(8)}` },
      { userId: null, phoneNumber: ngPhone(31), resolvedVia: 'unresolved', rawText: 'STATUS', parsedCommand: 'status', replyText: 'Number not registered. Reply HELP.', replySent: true },
      { userId: U(26), phoneNumber: tzPhone(1), resolvedVia: 'payments_phone', rawText: 'SALIO', parsedCommand: 'balance', replyText: null, replySent: false, replyError: 'SMS gateway timeout' },
    ]);
    await ins('support_tickets', [
      { ticket_number: 'TKT-2026-0041', user_id: ESTATE_USERS[1], asset_id: A(10), category: 'meter', priority: 'high', subject: 'Meter flatlines at night', description: 'My meter shows zero consumption overnight since last week.', status: 'in_progress', assigned_to: OPS, first_response_at: ago(2 * 24) },
      { ticket_number: 'TKT-2026-0042', user_id: ESTATE_USERS[3], category: 'billing', priority: 'normal', subject: 'Vend token not received', description: 'Paid ₦25,000 via Paystack but no SMS token arrived.', status: 'resolved', assigned_to: ADMIN, first_response_at: ago(3 * 24), resolved_at: ago(2 * 24), resolution_notes: 'Token re-issued manually; SMS gateway fault.' },
      { ticket_number: 'TKT-2026-0043', user_id: BIZ_IKEJA, asset_id: GEN2, category: 'asset', priority: 'urgent', subject: 'Gen 2 coolant alarm', description: 'Coolant temp alarm at 90% load.', status: 'closed', assigned_to: OPS, first_response_at: ago(2 * 24), resolved_at: ago(2 * 24), resolution_notes: 'Coolant flushed under WO-5.' },
      { ticket_number: 'TKT-2026-0044', user_id: U(27), category: 'account', priority: 'low', subject: 'Change payout number', description: 'Need to update M-Pesa payout MSISDN.', status: 'open' },
    ]);
    await ins('qr_code_history', [
      { user_id: ESTATE_USERS[0], operation_type: 'generate', payment_type: 'token', amount: 250_000, currency: 'NGN', merchant_id: 'VPP-NG-001', merchant_name: 'VPP Energy Lagos', reference: 'QR-SEED-0001', description: 'Prepaid vend QR', qr_code_data: J({ v: 1, amt: 250_000, cur: 'NGN', ref: 'QR-SEED-0001' }), status: 'completed', generated_at: ago(30), completed_at: ago(29) },
      { user_id: ESTATE_USERS[2], operation_type: 'scan', payment_type: 'bill', amount: 1_240_000, currency: 'NGN', bill_id: `BILL-${billingIds[1]}`, bill_type: 'postpaid', reference: 'QR-SEED-0002', qr_code_data: J({ v: 1, bill: billingIds[1] }), status: 'completed', scanned_at: ago(3 * 24), completed_at: ago(3 * 24) },
      { user_id: ESTATE_USERS[1], operation_type: 'generate', payment_type: 'merchant', amount: 500_000, currency: 'NGN', merchant_id: 'VPP-NG-001', merchant_name: 'VPP Energy Lagos', reference: 'QR-SEED-0003', qr_code_data: J({ v: 1, amt: 500_000 }), status: 'expired', generated_at: ago(5 * 24), expires_at: ago(4 * 24) },
      { user_id: U(26), operation_type: 'generate', payment_type: 'p2p', amount: 100_000, currency: 'TZS', recipient_id: String(U(27)), recipient_name: 'Neema Mtui', reference: 'QR-SEED-0004', qr_code_data: J({ v: 1, amt: 100_000, cur: 'TZS' }), status: 'pending', generated_at: ago(2) },
      { user_id: ESTATE_USERS[4], operation_type: 'scan', payment_type: 'token', amount: 750_000, currency: 'NGN', reference: 'QR-SEED-0005', qr_code_data: J({ v: 1, amt: 750_000 }), status: 'failed', scanned_at: ago(26) },
    ]);
    await ins('export_jobs', [
      { user_id: BIZ_IKEJA, period_start: ago(30 * 24), period_end: dayStartHoursAgo(0), format: 'csv', scope: 'both', status: 'ready', telemetry_row_count: 2_880, billing_row_count: 1, empty: false, content: 'assetId,timestamp,power\n...', checksum: hex(64), byte_size: 184_220, completed_at: ago(10) },
      { user_id: ESTATE_USERS[1], period_start: ago(30 * 24), period_end: dayStartHoursAgo(0), format: 'espi_xml', scope: 'usage', status: 'failed', failure_reason: 'Telemetry gap > 24h in window; ESPI export requires complete interval data', telemetry_row_count: 0, empty: true },
    ]);

    // -- 40. audit logs & alerts ---------------------------------------------------
    console.log('📋 audit logs & alerts');
    const auditRows: any[] = [];
    const auditDefs: Array<[number, string, string, string, string, string, string]> = [
      [ADMIN, 'Adaeze Okonkwo', 'admin', 'approve', 'asset', '21', 'community solar 1MWp'],
      [OPS, 'Babatunde Adeyemi', 'admin', 'create', 'dr_event', String(drE0), 'Lekki Evening Peak Shaving'],
      [OPS, 'Babatunde Adeyemi', 'admin', 'update', 'system_config', 'tariff-v3', 'Published dynamic tariff v3'],
      [ADMIN, 'Adaeze Okonkwo', 'admin', 'suspend', 'user', String(U(29)), 'Meter fault investigation'],
      [BIZ_IKEJA, 'Chukwuma Ezeani', 'user', 'payment', 'payment', String(paymentIds[10]), 'Invoice payment'],
      [ESTATE_USERS[0], 'Chiamaka Nwosu', 'user', 'trade', 'trade', String(tradeIds[0]), 'Export 25kWh'],
      [ESTATE_USERS[1], 'Emeka Obi', 'user', 'login', 'user', String(ESTATE_USERS[1]), 'Mobile login'],
      [ESTATE_USERS[2], 'Funke Alabi', 'user', 'configure', 'asset', String(A(11)), 'Updated min-SoC to 30%'],
      [ADMIN, 'Adaeze Okonkwo', 'admin', 'export', 'billing', String(billingIds[0]), 'Regulator data export'],
      [OPS, 'Babatunde Adeyemi', 'admin', 'reject', 'system_config', 'capacity-bid-3', 'Bid above price cap'],
    ];
    for (let i = 0; i < 25; i++) {
      const d = auditDefs[i % auditDefs.length];
      auditRows.push({
        user_id: d[0], user_name: d[1], user_role: d[2], action: d[3], entity_type: d[4],
        entity_id: d[5], entity_name: d[6],
        description: `${d[3]} on ${d[4]} ${d[6]} (seed ${i})`,
        ip_address: `102.89.${ri(1, 254)}.${ri(1, 254)}`,
        user_agent: 'Mozilla/5.0 (Android 14) VPP/2.4.1',
        status: i % 11 === 10 ? 'failure' : 'success',
        error_message: i % 11 === 10 ? 'Validation failed: stale etag' : null,
        created_at: ago(ri(1, 29 * 24)),
      });
    }
    await ins('audit_logs', auditRows);
    const alertRows: any[] = [];
    const alertTargets = [...ESTATE_USERS, BIZ_IKEJA, BIZ_KANO, ADMIN, ...NG_PEOPLE.slice(10, 14)];
    alertTargets.forEach((u, i) => {
      alertRows.push({
        userId: u,
        alertType: ['system', 'trading', 'billing', 'maintenance'][i % 4],
        severity: ['info', 'warning', 'error', 'critical'][i % 4],
        title: [
          'Welcome to VPP Energy',
          'Super-peak window starting 17:00',
          'Invoice overdue — action required',
          'Scheduled maintenance on your meter',
        ][i % 4],
        message: [
          'Your account is active. Add assets to start earning.',
          'Prices above ₦190/kWh from 17:00–21:00. Your battery is scheduled to export.',
          `Invoice INV-${i} is 5 days overdue. Pay via Paystack or Flutterwave to avoid disconnection.`,
          'Remote firmware maintenance 02:00–03:00; brief telemetry gaps expected.',
        ][i % 4],
        isRead: i % 3 === 0,
        readAt: i % 3 === 0 ? ago(ri(1, 48)) : null,
        createdAt: ago(ri(1, 26 * 24)),
      });
    });
    await ins('alerts', alertRows);

    // -- 41. infra credentials -----------------------------------------------------
    console.log('🔐 infra credentials');
    await ins('mqtt_broker_credentials', [
      { environment: 'production', credentials: J({ host: 'mqtt.vpp-energy.ng', port: 8883, username: 'vpp-fleet', tls: true }), is_active: 'true' },
      { environment: 'sandbox', credentials: J({ host: 'mqtt.sandbox.vpp-energy.ng', port: 1883, username: 'vpp-dev', tls: false }), is_active: 'false' },
    ]);
    await ins('payment_credentials', [
      { gateway: 'mpesa', environment: 'production', credentials: J({ consumerKey: 'enc:ak1...', consumerSecret: 'enc:sk1...', shortcode: '4085001' }), is_active: 'true', is_validated: 'true', last_validated: ago(3 * 24), created_by: ADMIN },
      { gateway: 'airtel_money', environment: 'sandbox', credentials: J({ clientId: 'enc:ak2...', clientSecret: 'enc:sk2...' }), is_active: 'false', is_validated: 'false', created_by: ADMIN },
      { gateway: 'tigo_pesa', environment: 'sandbox', credentials: J({ apiKey: 'enc:ak3...' }), is_active: 'false', is_validated: 'true', last_validated: ago(30 * 24), validation_error: 'Stale sandbox token; revalidation scheduled', created_by: OPS },
    ]);
    await ins('payment_gateway_logs', Array.from({ length: 10 }, (_, i) => ({
      payment_id: paymentIds[26 + (i % 4)],
      gateway: ['mpesa', 'airtel_money', 'tigo_pesa'][i % 3],
      request_type: ['STK_PUSH', 'QUERY', 'CALLBACK'][i % 3],
      request_payload: J({ amount: 5_000_000 + i * 100_000, msisdn: tzPhone((i % 4) + 1) }),
      response_payload: i % 4 === 3 ? null : J({ CheckoutRequestID: `ws_CO_${hex(12)}` }),
      status_code: i % 4 === 3 ? null : 200,
      status: i % 5 === 4 ? 'timeout' : i % 7 === 6 ? 'failed' : 'success',
      error_message: i % 5 === 4 ? 'Gateway timeout after 30s' : i % 7 === 6 ? 'Insufficient balance' : null,
      ip_address: '197.210.54.12',
      user_agent: 'VPP-Android/2.4.1',
      created_at: ago(ri(1, 20 * 24)),
    })));

    // -- 42. reconciliation ----------------------------------------------------------
    console.log('🔄 reconciliation');
    const reconIds = await insRet('payment_reconciliations', paymentIds.slice(26, 30).concat(paymentIds.slice(0, 2)).map((p, i) => ({
      paymentId: p,
      reconciliationDate: dayStartHoursAgo(1),
      status: i === 2 ? 'discrepancy' : i === 3 ? 'manual_review' : 'matched',
      gatewayTransactionId: `GTW-${hex(10)}`,
      gatewayAmount: 5_000_000 + i * 100_000,
      gatewayStatus: 'success',
      gatewayTimestamp: ago(26),
      dbAmount: i === 2 ? 4_900_000 + i * 100_000 : 5_000_000 + i * 100_000,
      dbStatus: 'completed',
      dbTimestamp: ago(26),
      amountDifference: i === 2 ? -100_000 : 0,
      statusMismatch: i === 2,
      timeDifference: ri(2, 900),
      resolvedBy: i === 2 ? OPS : null,
      resolvedAt: i === 2 ? ago(20) : null,
      resolutionNotes: i === 2 ? 'MNO charged fee at source; adjusted wallet credit' : null,
    })));
    await ins('reconciliation_audit_logs', [
      { reconciliationId: reconIds[0], action: 'created', performedBy: null, newStatus: 'matched', notes: 'Auto-matched by reference' },
      { reconciliationId: reconIds[1], action: 'matched', performedBy: null, newStatus: 'matched' },
      { reconciliationId: reconIds[2], action: 'flagged_discrepancy', performedBy: null, previousStatus: 'pending', newStatus: 'discrepancy', notes: 'Amount mismatch ₦1,000' },
      { reconciliationId: reconIds[2], action: 'resolved', performedBy: OPS, previousStatus: 'discrepancy', newStatus: 'matched', notes: 'MNO source fee confirmed' },
      { reconciliationId: reconIds[3], action: 'manual_review', performedBy: OPS, newStatus: 'manual_review', notes: 'Gateway reference not found in settlement file' },
      { reconciliationId: reconIds[4], action: 'created', performedBy: null, newStatus: 'matched' },
    ]);
    await ins('reconciliation_reports', [
      { reportDate: dayStartHoursAgo(1), reportType: 'daily', totalPayments: 14, matchedPayments: 12, unmatchedPayments: 1, discrepancies: 1, totalAmount: 84_000_000, matchedAmount: 78_900_000, discrepancyAmount: 100_000, gatewayBreakdown: J({ mpesa: 9, airtel_money: 3, tigo_pesa: 2 }), generatedBy: null },
      { reportDate: dayStartHoursAgo(7), reportType: 'weekly', totalPayments: 88, matchedPayments: 84, unmatchedPayments: 2, discrepancies: 2, totalAmount: 512_000_000, matchedAmount: 498_000_000, discrepancyAmount: 410_000, gatewayBreakdown: J({ mpesa: 50, airtel_money: 22, tigo_pesa: 16 }), generatedBy: ADMIN },
    ]);

    // -- 43. matter + lakehouse -------------------------------------------------------
    console.log('🏠 matter & lakehouse');
    const mnIds = await insRet('matter_nodes', [
      { fabric_id: 'F001', node_id: 'N-11', available: true, is_bridge: false, reported_attributes: J({ vendor: 'Huawei' }) },
      { fabric_id: 'F001', node_id: 'N-12', available: true, is_bridge: true, reported_attributes: J({ bridges: 2 }) },
      { fabric_id: 'F001', node_id: 'N-99', available: false, is_test_node: true, removed_at: ago(5 * 24) },
    ]);
    await ins('matter_node_attributes', [
      { matter_node_id: mnIds[0], endpoint_id: 1, cluster_id: 0x0702, attribute_id: 0x0000, attribute_path: '1/0x0702/0x0000', value: J({ currentSummation: 61_000 }), reported_at: ago(1) },
      { matter_node_id: mnIds[0], endpoint_id: 1, cluster_id: 0x0702, attribute_id: 0x0400, attribute_path: '1/0x0702/0x0400', value: J({ instantaneousDemand: 2_340 }), reported_at: ago(1) },
      { matter_node_id: mnIds[0], endpoint_id: 2, cluster_id: 0x0201, attribute_id: 0x0000, attribute_path: '2/0x0201/0x0000', value: J({ localTemperature: 2_450 }), reported_at: ago(2) },
      { matter_node_id: mnIds[1], endpoint_id: 1, cluster_id: 0x0006, attribute_id: 0x0000, attribute_path: '1/0x0006/0x0000', value: J({ onOff: true }), reported_at: ago(1) },
      { matter_node_id: mnIds[1], endpoint_id: 2, cluster_id: 0x0b04, attribute_id: 0x050b, attribute_path: '2/0x0b04/0x050b', value: J({ activePower: 1_120 }), reported_at: ago(3) },
      { matter_node_id: mnIds[1], endpoint_id: 2, cluster_id: 0x0b04, attribute_id: 0x0505, attribute_path: '2/0x0b04/0x0505', value: J({ rmsVoltage: 231 }), reported_at: ago(3) },
    ]);
    await ins('lakehouse_runs', [
      { dataset: 'telemetry', state: 'succeeded', runner: 'lakehouse-writer', started_at: ago(3), finished_at: new Date(ago(3).getTime() + 240_000), rows_written: 2_880, bytes_written: 184_220, object_key: 's3://vpp-lake/telemetry/2026-W16.parquet', object_digest: hex(64), from_watermark_at: ago(27), from_watermark_id: 1_004_411, to_watermark_at: ago(3), to_watermark_id: 1_007_291 },
      { dataset: 'billing', state: 'empty', runner: 'lakehouse-writer', started_at: ago(3), finished_at: new Date(ago(3).getTime() + 12_000), rows_written: 0, bytes_written: 0, from_watermark_at: ago(27), from_watermark_id: 3_311, to_watermark_at: ago(3), to_watermark_id: 3_311 },
      { dataset: 'telemetry', state: 'running', runner: 'lakehouse-writer', started_at: ago(0.2), from_watermark_at: ago(3), from_watermark_id: 1_007_291 },
    ]);
    await ins('lakehouse_baselines', [
      { dataset: 'telemetry', metric: 'hourly_power_mean', unit: 'watts', window_start: ago(30 * 24), window_end: dayStartHoursAgo(0), value: 1_144_820.5, sample_rows: 5_040, source_objects: ['s3://vpp-lake/telemetry/2026-W16.parquet'], runner: 'lakehouse-qc' },
      { dataset: 'telemetry', metric: 'voltage_p95', unit: 'millivolts', window_start: ago(30 * 24), window_end: dayStartHoursAgo(0), value: 11_150_000, sample_rows: 5_040, source_objects: ['s3://vpp-lake/telemetry/2026-W16.parquet'], runner: 'lakehouse-qc' },
      { dataset: 'billing', metric: 'weekly_revenue', unit: 'cents', window_start: ago(30 * 24), window_end: dayStartHoursAgo(0), value: 48_900_000, sample_rows: 15, source_objects: ['s3://vpp-lake/billing/2026-W16.parquet'], runner: 'lakehouse-qc' },
    ]);
    await ins('lakehouse_watermarks', [
      { dataset: 'telemetry', watermark_at: ago(3), watermark_id: 1_007_291, rows_ingested: 1_007_291 },
      { dataset: 'billing', watermark_at: ago(3), watermark_id: 3_311, rows_ingested: 3_311 },
      { dataset: 'audit', watermark_at: ago(3), watermark_id: 91_204, rows_ingested: 91_204 },
    ]);

    // -- 44. edge gateways / firmware fleet ops -----------------------------------
    console.log('🌐 edge gateways & firmware');
    const gwIds = await insRet('edge_gateways', [
      { gateway_id: 'GW-IKEJA-01', name: 'Ikeja Packaging Plant Gateway', site_id: null, community_id: null, hardware_model: 'Advantech ECU-150', firmware_version: '3.2.1', primary_protocol: 'mqtt', connection_endpoint: 'mqtts://mqtt.vpp-energy.ng:8883', can_operate_offline: true, local_storage_capacity_mb: 8_192, max_managed_devices: 64, certificate_fingerprint: hex(40), last_certificate_rotation: ago(60 * 24), status: 'online', last_heartbeat: ago(0.05), offline_mode: false, pending_commands_count: 0 },
      { gateway_id: 'GW-LEKKI-01', name: 'Lekki Pearl Estate Gateway', community_id: commLekki, hardware_model: 'Raspberry Pi CM4 IO', firmware_version: '3.1.0', primary_protocol: 'mqtt', connection_endpoint: 'mqtts://mqtt.vpp-energy.ng:8883', can_operate_offline: true, local_storage_capacity_mb: 4_096, max_managed_devices: 32, certificate_fingerprint: hex(40), last_certificate_rotation: ago(80 * 24), status: 'online', last_heartbeat: ago(0.05), offline_mode: false, pending_commands_count: 1 },
      { gateway_id: 'GW-KANO-01', name: 'Kano Franchise Gateway', hardware_model: 'Advantech ECU-150', firmware_version: '2.9.4', primary_protocol: 'grpc', connection_endpoint: 'grpcs://edge.vpp-energy.ng:9443', can_operate_offline: true, local_storage_capacity_mb: 8_192, max_managed_devices: 64, certificate_fingerprint: hex(40), status: 'degraded', last_heartbeat: ago(2), offline_mode: true, pending_commands_count: 3 },
    ]);
    await ins('edge_commands', [
      { gateway_id: gwIds[0], command_id: 'EC-0001', idempotency_key: hex(16), target_device_id: deviceIds[2], target_asset_id: BATT_IND, command_type: 'set_power', command_payload: J({ watts: -400_000 }), priority: 3, valid_until: ahead(1), status: 'completed', queued_at: ago(26), sent_at: ago(26), acknowledged_at: ago(26), completed_at: ago(25.9 as any), response_payload: J({ applied: true }), response_signature: hex(32) },
      { gateway_id: gwIds[1], command_id: 'EC-0002', idempotency_key: hex(16), target_device_id: deviceIds[6], target_asset_id: BATT_E0, command_type: 'set_soc_target', command_payload: J({ soc: 3_000 }), priority: 5, valid_until: ahead(2), status: 'acknowledged', queued_at: ago(4), sent_at: ago(4), acknowledged_at: ago(3.9 as any), response_signature: hex(32) },
      { gateway_id: gwIds[2], command_id: 'EC-0003', idempotency_key: hex(16), target_device_id: deviceIds[20], target_asset_id: TURBINE, command_type: 'set_power', command_payload: J({ watts: 4_200_000 }), priority: 2, valid_until: ago(1), status: 'queued', queued_at: ago(2) },
      { gateway_id: gwIds[2], command_id: 'EC-0004', idempotency_key: hex(16), command_type: 'update_config', command_payload: J({ telemetryInterval: 10 }), priority: 8, valid_until: ago(2), status: 'expired', queued_at: ago(8), error_message: 'Gateway offline beyond validity window' },
      { gateway_id: gwIds[1], command_id: 'EC-0005', idempotency_key: hex(16), target_device_id: deviceIds[15], target_asset_id: A(15), command_type: 'start_charging', command_payload: J({ watts: 2_000 }), priority: 6, valid_until: ahead(6), status: 'failed', queued_at: ago(5), sent_at: ago(5), error_message: 'Device offline' },
      { gateway_id: gwIds[0], command_id: 'EC-0006', idempotency_key: hex(16), command_type: 'emergency_stop', command_payload: J({ reason: 'drill' }), priority: 1, valid_until: ago(30 * 24 - 23), status: 'completed', queued_at: ago(30 * 24), sent_at: ago(30 * 24), acknowledged_at: ago(30 * 24), completed_at: ago(30 * 24 - 0.1 as any), response_payload: J({ stopped: true }), response_signature: hex(32) },
    ].map(r => ({ ...r })));
    const [fwCampaign] = await insRet('firmware_campaigns', [
      { name: 'Hexing HXE310 security patch 3.2.1', createdBy: OPS, model: 'HXE310', fromVersion: '3.1.0', targetVersion: '3.2.1', status: 'active', notes: 'TLS 1.3 + CVE-2026-1187 fix', startedAt: ago(2 * 24) },
    ]);
    await ins('firmware_targets', [
      { campaignId: fwCampaign, deviceId: deviceIds[4], assetId: METER_IND, expectedVersion: '3.2.1', reportedVersion: '3.2.1', observedAt: ago(1 * 24), status: 'applied' },
      { campaignId: fwCampaign, deviceId: deviceIds[7], assetId: METER_E0, expectedVersion: '3.2.1', reportedVersion: '3.1.0', observedAt: ago(12), status: 'offered' },
      { campaignId: fwCampaign, deviceId: deviceIds[22], assetId: F1_METER, expectedVersion: '3.2.1', reportedVersion: '3.1.0', observedAt: ago(12), status: 'failed', statusReason: 'Gateway offline during OTA window' },
      { campaignId: fwCampaign, deviceId: deviceIds[23], assetId: F2_METER, expectedVersion: '3.2.1', status: 'pending' },
    ]);

    // -- 45. commit ---------------------------------------------------------------
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\n❌ SEEDING FAILED — transaction rolled back.');
    throw e;
  }

  // -- 46. summary ------------------------------------------------------------------
  const allTables = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    )
  ).rows.map((r: any) => r.tablename);
  const exact: Record<string, number> = {};
  for (const t of allTables) {
    const r = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
    exact[t] = r.rows[0].n;
  }
  const zero = allTables.filter((t) => !exact[t]);
  const total = Object.values(exact).reduce((a, b) => a + b, 0);
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n================= SEED SUMMARY =================');
  for (const t of allTables) console.log(`  ${t.padEnd(38)} ${String(exact[t]).padStart(7)}`);
  console.log('------------------------------------------------');
  console.log(`  TABLES: ${allTables.length}   TOTAL ROWS: ${total}   DURATION: ${dur}s`);
  if (zero.length) {
    console.error(`\n❌ ${zero.length} tables still empty: ${zero.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ All 169 tables populated.');
  }
  await client.end();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
