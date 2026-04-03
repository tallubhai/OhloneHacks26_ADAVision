import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import { logout } from "./auth";
import { generateOpenAiSummary } from "./services/aiSummary";

const sidebarItems = [
  "Overview",
  "Import",
  "Reports",
  "Settings"
];

function evaluateDoor(doorWidthInches, minDoorWidth = 32) {
  return Number(doorWidthInches) >= Number(minDoorWidth);
}

function evaluateRamp(angleDegrees, minSlopeRatio = 12) {
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const tangent = Math.tan(radians);

  if (!Number.isFinite(tangent) || tangent <= 0) {
    return false;
  }

  const slopeRatio = 1 / tangent;
  return slopeRatio >= Number(minSlopeRatio);
}

function calculateSlopeRatio(angleDegrees) {
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const tangent = Math.tan(radians);
  if (!Number.isFinite(tangent) || tangent <= 0) {
    return 0;
  }
  return 1 / tangent;
}

function generateRawReport({
  buildingName,
  inspectorName,
  inspectionDate,
  notes,
  measurements,
  minDoorWidth,
  minSlopeRatio
}) {
  const latest = measurements[0];
  const latestDoorPass = evaluateDoor(latest.doorWidth, minDoorWidth);
  const latestRampPass = evaluateRamp(latest.rampAngle, minSlopeRatio);
  const latestSlope = calculateSlopeRatio(latest.rampAngle);

  const measurementRows = measurements
    .slice(0, 10)
    .map((entry, index) => {
      const rowDoorPass = evaluateDoor(entry.doorWidth, minDoorWidth);
      const rowRampPass = evaluateRamp(entry.rampAngle, minSlopeRatio);
      const rowSlope = calculateSlopeRatio(entry.rampAngle);
      return `${index + 1}. [${entry.timestamp}] Door=${Number(entry.doorWidth).toFixed(
        1
      )} in (${rowDoorPass ? "PASS" : "FAIL"}) | Ramp=1:${rowSlope.toFixed(2)} (${rowRampPass ? "PASS" : "FAIL"})`;
    })
    .join("\n");

  return `ADA Inspection Report
Building: ${buildingName}
Inspector: ${inspectorName}
Inspection Date: ${inspectionDate}
Generated: ${new Date().toLocaleString()}

Ramp Slope: 1:${latestSlope.toFixed(2)} (${latestRampPass ? "Compliant" : "Non-compliant"}, threshold 1:${minSlopeRatio})
Door Width: ${Number(latest.doorWidth).toFixed(1)} in (${latestDoorPass ? "Compliant" : "Non-compliant"}, threshold ${minDoorWidth} in)

Recent Measurements:
${measurementRows}

Notes: ${notes}
`;
}

function summarizeReport({ buildingName, measurements, minDoorWidth, minSlopeRatio, verbosity }) {
  const latest = measurements[0];
  const latestDoorPass = evaluateDoor(latest.doorWidth, minDoorWidth);
  const latestRampPass = evaluateRamp(latest.rampAngle, minSlopeRatio);
  const failureCount = measurements.filter(
    (entry) =>
      !evaluateDoor(entry.doorWidth, minDoorWidth) ||
      !evaluateRamp(entry.rampAngle, minSlopeRatio)
  ).length;
  const failureRate = failureCount / measurements.length;

  const severity =
    failureRate === 0 ? "Low" : failureRate > 0.5 ? "High" : "Medium";

  if (!latestDoorPass && !latestRampPass) {
    const base = `Summary:
Ramp is too steep. Door is too narrow. ${buildingName} fails ADA compliance.
Severity: ${severity} (${failureCount}/${measurements.length} recent measurements contain failures).`;
    if (verbosity === "detailed") {
      return `${base}
Recommended action: increase doorway clearance to at least ${minDoorWidth} in and flatten ramp toward 1:${minSlopeRatio}.`;
    }
    return base;
  }

  if (!latestDoorPass) {
    const base = `Summary:
Door is too narrow. Ramp slope is within limit. ${buildingName} fails ADA compliance until doorway width is corrected.
Severity: ${severity} (${failureCount}/${measurements.length} recent measurements contain failures).`;
    if (verbosity === "detailed") {
      return `${base}
Recommended action: widen clear door width to at least ${minDoorWidth} in.`;
    }
    return base;
  }

  if (!latestRampPass) {
    const base = `Summary:
Ramp is too steep. Door width passes minimum requirement. ${buildingName} fails ADA compliance until ramp slope is corrected.
Severity: ${severity} (${failureCount}/${measurements.length} recent measurements contain failures).`;
    if (verbosity === "detailed") {
      return `${base}
Recommended action: reduce ramp steepness to at most 1:${minSlopeRatio}.`;
    }
    return base;
  }

  const passSummary = `Summary:
Ramp slope and door width pass ADA thresholds in the latest reading. ${buildingName} is currently compliant.
Severity: ${severity} (${failureCount}/${measurements.length} recent measurements contain failures).`;
  if (verbosity === "concise") {
    return "Summary: Latest reading passes ADA thresholds. Building currently compliant.";
  }
  if (verbosity === "detailed") {
    return `${passSummary}
Recommendation: continue periodic checks to maintain compliance over time.`;
  }
  return passSummary;
}

function parseImportPayload(rawPayload) {
  const payload = rawPayload.trim();
  if (!payload) {
    throw new Error("Payload is empty.");
  }

  const normalize = (value) => String(value || "").toLowerCase().replace(/[\s-]/g, "_");
  const toNumber = (value, label) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${label} is missing or invalid.`);
    }
    return numeric;
  };

  const fromJsonObject = (obj) => {
    const entries = Object.entries(obj).reduce((acc, [key, value]) => {
      acc[normalize(key)] = value;
      return acc;
    }, {});

    const door = entries.door_width ?? entries.doorwidth ?? entries.door;
    const rampAngle = entries.ramp_angle ?? entries.rampangle ?? entries.angle ?? entries.theta;
    const rampSlopeRatio = entries.ramp_slope ?? entries.rampslope ?? entries.slope_ratio;

    const doorWidth = toNumber(door, "Door width");
    if (doorWidth <= 0) {
      throw new Error("Door width must be a positive number.");
    }

    if (rampAngle != null) {
      const angleDegrees = toNumber(rampAngle, "Ramp angle");
      if (angleDegrees <= 0 || angleDegrees >= 89.9) {
        throw new Error("Ramp angle must be between 0 and 89.9 degrees.");
      }
      return { doorWidth, rampAngle: angleDegrees, sourceFormat: "JSON", sourceType: "ramp_angle" };
    }

    if (rampSlopeRatio != null) {
      const ratio = toNumber(rampSlopeRatio, "Ramp slope");
      if (ratio <= 0) {
        throw new Error("Ramp slope must be a positive number.");
      }
      const angleDegrees = (Math.atan(1 / ratio) * 180) / Math.PI;
      return { doorWidth, rampAngle: angleDegrees, sourceFormat: "JSON", sourceType: "ramp_slope" };
    }

    throw new Error("Missing ramp value. Include ramp_angle or ramp_slope.");
  };

  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      return fromJsonObject(parsed);
    }
  } catch (_error) {
    // Fallback to CSV parsing below.
  }

  const csvParts = payload.split(",").map((part) => part.trim()).filter(Boolean);
  if (csvParts.length < 2) {
    throw new Error("CSV format must include at least two values.");
  }

  if (csvParts.some((part) => part.includes(":") || part.includes("="))) {
    const csvObject = {};
    csvParts.forEach((part) => {
      const [key, value] = part.split(/[:=]/).map((item) => item.trim());
      if (key && value != null) {
        csvObject[key] = value;
      }
    });
    return fromJsonObject(csvObject);
  }

  const rampSlope = toNumber(csvParts[0], "Ramp slope");
  const doorWidth = toNumber(csvParts[1], "Door width");
  if (rampSlope <= 0 || doorWidth <= 0) {
    throw new Error("CSV values must be positive numbers.");
  }
  const angleDegrees = (Math.atan(1 / rampSlope) * 180) / Math.PI;
  return { doorWidth, rampAngle: angleDegrees, sourceFormat: "CSV", sourceType: "ramp_slope" };
}

export default function App() {
  const [activeMenu, setActiveMenu] = useState("Overview");
  const [authUser, setAuthUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [buildingName, setBuildingName] = useState("City Hall");
  const [inspectorName, setInspectorName] = useState("Bilal Salman");
  const [inspectionDate, setInspectionDate] = useState(new Date().toISOString().slice(0, 10));
  const [minSlopeRatio, setMinSlopeRatio] = useState(12);
  const [minDoorWidth, setMinDoorWidth] = useState(32);
  const [doorWidth, setDoorWidth] = useState(29);
  const [rampAngle, setRampAngle] = useState(6.2);
  const [bluetoothState, setBluetoothState] = useState("Not connected");
  const [knownBluetoothDevices, setKnownBluetoothDevices] = useState([]);
  const [selectedBluetoothDevice, setSelectedBluetoothDevice] = useState("");
  const [themeMode, setThemeMode] = useState("light");
  const [aiSummaryEnabled, setAiSummaryEnabled] = useState(true);
  const [aiVerbosity, setAiVerbosity] = useState("standard");
  const [lastRefreshedAt, setLastRefreshedAt] = useState("Not refreshed yet");
  const [reportText, setReportText] = useState("");
  const [summaryText, setSummaryText] = useState("Click Generate Summary after building a report.");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [reportNotes, setReportNotes] = useState(
    "Measurements taken during ADA Vision field test. Review ADA section 405.2 and door clearance standards before final submission."
  );
  const [compiledMeasurements, setCompiledMeasurements] = useState([]);
  const [logs, setLogs] = useState([]);
  const [importPayload, setImportPayload] = useState('{"ramp_slope": 1.09, "door_width": 29}');
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState("");
  const [importedReadings, setImportedReadings] = useState([]);

  const doorPass = evaluateDoor(doorWidth, minDoorWidth);
  const rampPass = evaluateRamp(rampAngle, minSlopeRatio);
  const slopeRatio = calculateSlopeRatio(rampAngle);

  const casesTotal = logs.length || 1;
  const compliantCount = logs.filter((item) => item.doorPass && item.rampPass).length;
  const actionRequired = logs.filter((item) => !item.doorPass || !item.rampPass).length;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthChecking(false);
      if (!user) {
        window.location.href = "/login.html";
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const savedLogs = localStorage.getItem("adaVisionLogs");
    if (savedLogs) {
      try {
        const parsed = JSON.parse(savedLogs);
        if (Array.isArray(parsed)) {
          setLogs(parsed);
        }
      } catch (error) {
        console.error("Unable to parse saved logs", error);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("adaVisionLogs", JSON.stringify(logs));
  }, [logs]);

  useEffect(() => {
    const savedImports = sessionStorage.getItem("adaVisionImportedReadings");
    if (savedImports) {
      try {
        const parsed = JSON.parse(savedImports);
        if (Array.isArray(parsed)) {
          setImportedReadings(parsed);
        }
      } catch (error) {
        console.error("Unable to parse imported readings", error);
      }
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem("adaVisionImportedReadings", JSON.stringify(importedReadings));
  }, [importedReadings]);

  useEffect(() => {
    const savedDevices = localStorage.getItem("adaVisionKnownBluetoothDevices");
    if (savedDevices) {
      try {
        const parsed = JSON.parse(savedDevices);
        if (Array.isArray(parsed)) {
          setKnownBluetoothDevices(parsed);
        }
      } catch (error) {
        console.error("Unable to parse known bluetooth devices", error);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("adaVisionKnownBluetoothDevices", JSON.stringify(knownBluetoothDevices));
  }, [knownBluetoothDevices]);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", themeMode === "dark");
    return () => document.body.classList.remove("theme-dark");
  }, [themeMode]);

  const exposureValue = useMemo(() => {
    return (actionRequired * 1200 + (rampPass && doorPass ? 400 : 0)).toLocaleString();
  }, [actionRequired, rampPass, doorPass]);
  const complianceScore = useMemo(() => {
    let passedChecks = 0;
    if (doorPass) passedChecks += 1;
    if (rampPass) passedChecks += 1;
    return Math.round((passedChecks / 2) * 100);
  }, [doorPass, rampPass]);
  const reportSeverity = useMemo(() => {
    const source = compiledMeasurements.length > 0 ? compiledMeasurements : [{ doorWidth, rampAngle }];
    const failures = source.filter(
      (entry) =>
        !evaluateDoor(entry.doorWidth, minDoorWidth) ||
        !evaluateRamp(entry.rampAngle, minSlopeRatio)
    ).length;
    const ratio = failures / source.length;
    if (ratio === 0) {
      return { label: "Low", className: "ok" };
    }
    if (ratio > 0.5) {
      return { label: "High", className: "bad" };
    }
    return { label: "Medium", className: "warn" };
  }, [compiledMeasurements, doorWidth, rampAngle, minDoorWidth, minSlopeRatio]);

  async function handleLogout() {
    await logout();
    window.location.href = "/login.html";
  }

  async function connectBluetooth() {
    if (!("bluetooth" in navigator)) {
      setBluetoothState("Web Bluetooth is not available in this browser.");
      return;
    }

    try {
      setBluetoothState("Connecting...");
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ["battery_service"]
      });
      const deviceName = device?.name || "Unnamed device";
      setSelectedBluetoothDevice(deviceName);
      setKnownBluetoothDevices((prev) =>
        [deviceName, ...prev.filter((item) => item !== deviceName)].slice(0, 10)
      );
      setBluetoothState("Device selected. Ready for your sensor stream.");
    } catch (error) {
      setBluetoothState(`Connection canceled: ${error.message}`);
    }
  }

  function runComplianceCheck() {
    const entry = {
      id: Date.now(),
      buildingName,
      inspectorName,
      doorWidth: Number(doorWidth),
      rampAngle: Number(rampAngle),
      slopeRatio: Number(slopeRatio.toFixed(1)),
      doorPass,
      rampPass,
      overallPass: doorPass && rampPass,
      timestamp: new Date().toLocaleString()
    };
    setLogs((prev) => [entry, ...prev].slice(0, 50));
  }

  function refreshLatestReadings() {
    if (logs.length > 0) {
      const latest = logs[0];
      setDoorWidth(latest.doorWidth);
      setRampAngle(latest.rampAngle);
      setLastRefreshedAt(new Date().toLocaleString());
      setBluetoothState("Readings refreshed from latest logged measurement.");
      return;
    }

    const simulatedDoor = Math.max(24, Number(doorWidth) + (Math.random() * 2 - 1.5));
    const simulatedAngle = Math.max(2, Number(rampAngle) + (Math.random() * 0.8 - 0.4));
    setDoorWidth(Number(simulatedDoor.toFixed(1)));
    setRampAngle(Number(simulatedAngle.toFixed(1)));
    setLastRefreshedAt(new Date().toLocaleString());
    setBluetoothState("No saved logs yet. Displaying latest simulated sensor values.");
  }

  function generateReport() {
    const sourceMeasurements = [
      ...logs.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        doorWidth: Number(entry.doorWidth),
        rampAngle: Number(entry.rampAngle)
      })),
      ...importedReadings.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        doorWidth: Number(entry.doorWidth),
        rampAngle: Number(entry.rampAngle)
      }))
    ]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 20);

    const fallbackMeasurement = {
      id: Date.now(),
      timestamp: new Date().toLocaleString(),
      doorWidth: Number(doorWidth),
      rampAngle: Number(rampAngle)
    };
    const measurements = sourceMeasurements.length > 0 ? sourceMeasurements : [fallbackMeasurement];

    const rawReport = generateRawReport({
      buildingName,
      inspectorName,
      inspectionDate,
      notes: reportNotes,
      measurements,
      minDoorWidth,
      minSlopeRatio
    });
    setCompiledMeasurements(measurements);
    setReportText(rawReport);
  }

  async function generateSummary() {
    if (!aiSummaryEnabled) {
      setSummaryText("AI summary is disabled in Settings.");
      return;
    }
    const measurements =
      compiledMeasurements.length > 0
        ? compiledMeasurements
        : [
            {
              id: Date.now(),
              timestamp: new Date().toLocaleString(),
              doorWidth: Number(doorWidth),
              rampAngle: Number(rampAngle)
            }
          ];
    const fallbackSummary = summarizeReport({
      buildingName,
      measurements,
      minDoorWidth,
      minSlopeRatio,
      verbosity: aiVerbosity
    });

    if (!reportText.trim()) {
      setSummaryText(fallbackSummary);
      return;
    }

    try {
      setSummaryLoading(true);
      const aiSummary = await generateOpenAiSummary({
        rawReport: reportText,
        buildingName,
        verbosity: aiVerbosity
      });
      setSummaryText(aiSummary);
    } catch (error) {
      setSummaryText(`${fallbackSummary}\n\nAI fallback notice: ${error.message}`);
    } finally {
      setSummaryLoading(false);
    }
  }

  function exportReportCsv() {
    const measurements =
      compiledMeasurements.length > 0
        ? compiledMeasurements
        : [
            {
              id: Date.now(),
              timestamp: new Date().toLocaleString(),
              doorWidth: Number(doorWidth),
              rampAngle: Number(rampAngle)
            }
          ];

    const header = "timestamp,door_width_in,ramp_angle_deg,slope_ratio,door_status,ramp_status,overall_status";
    const rows = measurements.map((entry) => {
      const csvDoorPass = evaluateDoor(entry.doorWidth, minDoorWidth);
      const csvRampPass = evaluateRamp(entry.rampAngle, minSlopeRatio);
      const csvSlope = calculateSlopeRatio(entry.rampAngle);
      const overall = csvDoorPass && csvRampPass ? "PASS" : "FAIL";
      return `"${entry.timestamp}",${Number(entry.doorWidth).toFixed(2)},${Number(entry.rampAngle).toFixed(
        2
      )},${csvSlope.toFixed(2)},${csvDoorPass ? "PASS" : "FAIL"},${csvRampPass ? "PASS" : "FAIL"},${overall}`;
    });

    const csvContent = [header, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ada-vision-report-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportReportPdf() {
    const printableText = reportText || "Generate report first.";
    const popup = window.open("", "_blank", "width=900,height=700");
    if (!popup) return;

    popup.document.write(`<html><head><title>ADA Vision Report</title></head><body><pre>${printableText}</pre></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function testBluetoothConnection() {
    if (!selectedBluetoothDevice) {
      setBluetoothState("No bluetooth device selected. Choose one in Settings or connect first.");
      return;
    }
    setBluetoothState(`Connection test successful with ${selectedBluetoothDevice}.`);
  }

  function importMeasurementPayload() {
    setImportError("");
    setImportSuccess("");

    try {
      const parsed = parseImportPayload(importPayload);
      const importedEntry = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        format: parsed.sourceFormat,
        sourceType: parsed.sourceType,
        doorWidth: Number(parsed.doorWidth.toFixed(2)),
        rampAngle: Number(parsed.rampAngle.toFixed(2)),
        slopeRatio: Number(calculateSlopeRatio(parsed.rampAngle).toFixed(2))
      };

      setImportedReadings((prev) => [importedEntry, ...prev].slice(0, 30));
      setDoorWidth(importedEntry.doorWidth);
      setRampAngle(importedEntry.rampAngle);
      setLastRefreshedAt(importedEntry.timestamp);
      setBluetoothState("Imported payload parsed and applied.");
      setImportSuccess(`Imported ${parsed.sourceFormat} payload successfully.`);
    } catch (error) {
      setImportError(error.message || "Unable to parse payload.");
    }
  }

  function useLatestImportedReading() {
    if (importedReadings.length === 0) {
      setImportError("No imported readings available yet.");
      setImportSuccess("");
      return;
    }

    const latest = importedReadings[0];
    setDoorWidth(latest.doorWidth);
    setRampAngle(latest.rampAngle);
    setLastRefreshedAt(new Date().toLocaleString());
    setBluetoothState("Latest imported reading applied to live dashboard.");
    setImportError("");
    setImportSuccess("Latest imported reading applied.");
  }

  if (authChecking) {
    return <main className="auth-page">Checking session...</main>;
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h2>ADA Vision</h2>
        </div>
        <nav className="menu">
          {sidebarItems.map((item) => (
            <button
              key={item}
              className={`menu-item ${activeMenu === item ? "active" : ""}`}
              onClick={() => setActiveMenu(item)}
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>ADA Vision - {activeMenu}</h1>
          <div className="actions">
            <span className="badge">{themeMode === "dark" ? "Dark" : "Light"}</span>
            <span className="badge">{authUser?.email || "Inspector"}</span>
            <button className="btn btn-outline" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </header>

        {activeMenu === "Overview" && (
          <>
            <section className="grid-cards">
              <article className="stat-card">
                <p className="stat-title">Total Cases</p>
                <p className="stat-value">{casesTotal}</p>
                <p className="stat-meta">All ADA checks</p>
              </article>
              <article className="stat-card">
                <p className="stat-title">Compliance Score</p>
                <p className="stat-value">{complianceScore}%</p>
                <p className="stat-meta">Based on ramp + door checks</p>
              </article>
              <article className="stat-card">
                <p className="stat-title">Action Required</p>
                <p className="stat-value">{actionRequired}</p>
                <p className="stat-meta">Needs remediation</p>
              </article>
              <article className="stat-card">
                <p className="stat-title">Exposure</p>
                <p className="stat-value">${exposureValue}</p>
                <p className="stat-meta">Open liability estimate</p>
              </article>
            </section>

            <section className="panel-grid">
              <article className="panel">
                <h3>Live Measurements</h3>
                <p>Bluetooth sensor data and manual controls for the current inspection.</p>
                <div className="measurement-grid">
                  <div className="metric-box">
                    <strong>Door Width (inches)</strong>
                    <p className="metric-value">{Number(doorWidth).toFixed(1)} in</p>
                    <p className={`metric-result ${doorPass ? "ok" : "bad"}`}>
                      {doorPass
                        ? `✅ Compliant (>= ${minDoorWidth} in)`
                        : `❌ Non-compliant (< ${minDoorWidth} in)`}
                    </p>
                  </div>
                  <div className="metric-box">
                    <strong>Ramp Slope</strong>
                    <p className="metric-value">1:{slopeRatio.toFixed(1)}</p>
                    <p className={`metric-result ${rampPass ? "ok" : "bad"}`}>
                      {rampPass
                        ? `✅ Compliant (>= 1:${minSlopeRatio})`
                        : `❌ Non-compliant (< 1:${minSlopeRatio})`}
                    </p>
                  </div>
                </div>
                <div className="row">
                  <input
                    type="text"
                    value={buildingName}
                    onChange={(event) => setBuildingName(event.target.value)}
                    placeholder="Building name"
                  />
                  <input
                    type="text"
                    value={inspectorName}
                    onChange={(event) => setInspectorName(event.target.value)}
                    placeholder="Inspector name"
                  />
                  <input
                    type="date"
                    value={inspectionDate}
                    onChange={(event) => setInspectionDate(event.target.value)}
                  />
                </div>
                <div className="row" style={{ marginTop: "8px" }}>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={doorWidth}
                    onChange={(event) => setDoorWidth(event.target.value)}
                    placeholder="Door width in inches"
                  />
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={rampAngle}
                    onChange={(event) => setRampAngle(event.target.value)}
                    placeholder="Ramp angle in degrees"
                  />
                </div>
                <div className="row" style={{ marginTop: "10px" }}>
                  <button className="btn btn-outline" onClick={connectBluetooth}>
                    Connect Bluetooth
                  </button>
                  <button className="btn btn-outline" onClick={refreshLatestReadings}>
                    Refresh Readings
                  </button>
                  <button className="btn btn-primary" onClick={runComplianceCheck}>
                    Save Inspection Log
                  </button>
                </div>
                <p style={{ marginTop: "9px", marginBottom: 0, fontSize: "0.85rem" }}>
                  Bluetooth status: <strong>{bluetoothState}</strong>
                </p>
                <p style={{ marginTop: "4px", marginBottom: 0, fontSize: "0.85rem" }}>
                  Last refreshed: <strong>{lastRefreshedAt}</strong>
                </p>
              </article>

              <article className="panel">
                <h3>Recent Activity Log</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Door</th>
                      <th>Ramp</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.length === 0 ? (
                      <tr>
                        <td colSpan="4">No logs yet. Save an inspection to start tracking history.</td>
                      </tr>
                    ) : (
                      logs.slice(0, 8).map((log) => (
                        <tr key={log.id}>
                          <td>{log.timestamp}</td>
                          <td>{log.doorWidth} in</td>
                          <td>1:{log.slopeRatio}</td>
                          <td className={log.overallPass ? "ok" : "bad"}>
                            {log.overallPass ? "✅ Pass" : "❌ Fail"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </article>
            </section>
          </>
        )}

        {activeMenu === "Reports" && (
          <section className="bottom-grid" style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Raw Report Generator</h3>
              <p>Compile measurements into official ADA report format and export as CSV/PDF.</p>
              <div className="row" style={{ marginBottom: "8px" }}>
                <input
                  type="text"
                  value={buildingName}
                  onChange={(event) => setBuildingName(event.target.value)}
                  placeholder="Building name"
                />
                <input
                  type="text"
                  value={inspectorName}
                  onChange={(event) => setInspectorName(event.target.value)}
                  placeholder="Inspector name"
                />
              </div>
              <div className="row">
                <textarea
                  value={reportNotes}
                  onChange={(event) => setReportNotes(event.target.value)}
                  placeholder="Report notes / filler text"
                />
              </div>
              <div className="row" style={{ marginTop: "8px" }}>
                <textarea
                  value={reportText}
                  onChange={(event) => setReportText(event.target.value)}
                  placeholder="Generated report will appear here..."
                />
              </div>
              <div className="row" style={{ marginTop: "10px" }}>
                <button className="btn btn-primary" onClick={generateReport}>
                  Compile Raw Report
                </button>
                <button className="btn btn-outline" onClick={exportReportCsv}>
                  Export CSV
                </button>
                <button className="btn btn-outline" onClick={exportReportPdf}>
                  Export PDF
                </button>
              </div>
            </article>

            <article className="panel">
              <h3>AI Summary</h3>
              <p>Convert dense report text into concise plain-English findings.</p>
              <p className="stat-meta">AI summary: {aiSummaryEnabled ? "Enabled" : "Disabled"}</p>
              <p className={`metric-result ${reportSeverity.className}`}>
                Compliance severity: {reportSeverity.label}
              </p>
              <div className="summary-box">{summaryText}</div>
              <div className="row" style={{ marginTop: "10px" }}>
                <button
                  className="btn btn-primary"
                  onClick={generateSummary}
                  disabled={!aiSummaryEnabled || summaryLoading}
                >
                  {summaryLoading ? "Generating..." : "Generate AI Summary"}
                </button>
              </div>
            </article>
          </section>
        )}

        {activeMenu === "Import" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Import</h3>
              <p>
                Receive raw Bluetooth payloads (JSON/CSV), validate values, and store imported
                readings for this session.
              </p>
              <div className="row">
                <textarea
                  value={importPayload}
                  onChange={(event) => setImportPayload(event.target.value)}
                  placeholder='Example: {"ramp_slope": 1.09, "door_width": 29} or ramp_slope:1.09,door_width:29'
                />
              </div>
              {importError && (
                <p className="status-error" style={{ marginTop: "10px" }}>
                  {importError}
                </p>
              )}
              {importSuccess && (
                <p className="status-success" style={{ marginTop: "10px" }}>
                  {importSuccess}
                </p>
              )}
              <div className="row">
                <button className="btn btn-outline" onClick={connectBluetooth}>
                  Connect Bluetooth Device
                </button>
                <button className="btn btn-primary" onClick={importMeasurementPayload}>
                  Parse & Save Reading
                </button>
                <button className="btn btn-outline" onClick={useLatestImportedReading}>
                  Use Latest Imported
                </button>
              </div>
              <div className="row" style={{ marginTop: "10px" }}>
                <button className="btn btn-outline" onClick={refreshLatestReadings}>
                  Refresh Live Dashboard Values
                </button>
              </div>
            </article>

            <article className="panel" style={{ marginTop: "10px" }}>
              <h3>Recent Imported Readings</h3>
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Format</th>
                    <th>Door</th>
                    <th>Ramp (deg)</th>
                    <th>Slope</th>
                  </tr>
                </thead>
                <tbody>
                  {importedReadings.length === 0 ? (
                    <tr>
                      <td colSpan="5">No imports yet. Paste payload and click Parse & Save Reading.</td>
                    </tr>
                  ) : (
                    importedReadings.slice(0, 8).map((reading) => (
                      <tr key={reading.id}>
                        <td>{reading.timestamp}</td>
                        <td>{reading.format}</td>
                        <td>{reading.doorWidth} in</td>
                        <td>{reading.rampAngle} deg</td>
                        <td>1:{reading.slopeRatio}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </article>
          </section>
        )}

        {activeMenu === "Settings" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Settings</h3>
              <p>Configure building info, thresholds, AI behavior, and Bluetooth settings.</p>
              <div className="row">
                <input
                  type="text"
                  value={buildingName}
                  onChange={(event) => setBuildingName(event.target.value)}
                  placeholder="Default building name"
                />
                <input
                  type="text"
                  value={inspectorName}
                  onChange={(event) => setInspectorName(event.target.value)}
                  placeholder="Default inspector name"
                />
                <input
                  type="date"
                  value={inspectionDate}
                  onChange={(event) => setInspectionDate(event.target.value)}
                />
              </div>
              <div className="row" style={{ marginTop: "8px" }}>
                <input
                  type="number"
                  min="1"
                  step="0.5"
                  value={minSlopeRatio}
                  onChange={(event) => setMinSlopeRatio(Number(event.target.value))}
                  placeholder="Max ramp standard (ratio, default 12)"
                />
                <input
                  type="number"
                  min="1"
                  step="0.5"
                  value={minDoorWidth}
                  onChange={(event) => setMinDoorWidth(Number(event.target.value))}
                  placeholder="Min door width (inches, default 32)"
                />
              </div>
              <div className="row" style={{ marginTop: "8px" }}>
                <label className="input-label">
                  AI Summary
                  <select
                    value={aiSummaryEnabled ? "on" : "off"}
                    onChange={(event) => setAiSummaryEnabled(event.target.value === "on")}
                  >
                    <option value="on">Enabled</option>
                    <option value="off">Disabled</option>
                  </select>
                </label>
                <label className="input-label">
                  AI Verbosity
                  <select
                    value={aiVerbosity}
                    onChange={(event) => setAiVerbosity(event.target.value)}
                    disabled={!aiSummaryEnabled}
                  >
                    <option value="concise">Concise</option>
                    <option value="standard">Standard</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </label>
              </div>
              <div className="row" style={{ marginTop: "8px" }}>
                <label className="input-label">
                  Bluetooth Device
                  <select
                    value={selectedBluetoothDevice}
                    onChange={(event) => setSelectedBluetoothDevice(event.target.value)}
                  >
                    <option value="">Select device</option>
                    {knownBluetoothDevices.map((deviceName) => (
                      <option key={deviceName} value={deviceName}>
                        {deviceName}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn btn-outline" onClick={connectBluetooth}>
                  Select Device
                </button>
                <button className="btn btn-primary" onClick={testBluetoothConnection}>
                  Test Connection
                </button>
              </div>
              <div className="row" style={{ marginTop: "8px" }}>
                <label className="input-label">
                  Theme
                  <select value={themeMode} onChange={(event) => setThemeMode(event.target.value)}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
              </div>
            </article>
          </section>
        )}
      </main>
    </div>
  );
}
