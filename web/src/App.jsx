import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { logout } from "./auth";
import { generateAiSummary, generateAiWebsiteReport } from "./services/aiSummary";

const sidebarItems = [
  "Overview",
  "Import",
  "Reports",
  "Websites",
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

function formatImpactClass(impact) {
  if (impact === "critical" || impact === "serious") return "bad";
  if (impact === "moderate") return "warn";
  return "ok";
}

function generateWebsiteFallbackReport(scanResult) {
  const violations = scanResult?.violations || [];
  const counts = scanResult?.counts || {};
  const criticalCount = violations.filter((item) => item.impact === "critical").length;
  const seriousCount = violations.filter((item) => item.impact === "serious").length;
  const topIssue = violations[0];
  const passedChecks = scanResult?.passedChecks || [];

  if (violations.length === 0) {
    return `Executive Summary:
This automated scan did not detect accessibility violations on this page.

What Passed:
The page passed ${counts.passes || 0} automated checks, indicating strong baseline support for many accessibility rules.

What Failed:
No failed checks were returned in this scan.

Why It Matters:
Passing automated checks reduces risk, but automation cannot validate every real-world user interaction.

Recommended Fixes:
Perform a quick manual keyboard and screen-reader walkthrough before final sign-off to confirm usability in practice.`;
  }

  return `Executive Summary:
This page has ${counts.violations || 0} accessibility violations, including ${criticalCount} critical and ${seriousCount} serious issues.

What Passed:
The page passed ${counts.passes || 0} checks. Example passing rules include: ${passedChecks
    .slice(0, 3)
    .map((item) => item.help || item.id)
    .join("; ") || "standard document checks"}.

What Failed:
The most urgent issue is "${topIssue?.help || "Unspecified issue"}" with ${topIssue?.impact || "unknown"} impact. Additional failures indicate gaps in landmark structure and semantic clarity for assistive technology.

Why It Matters:
These failures can make it harder for screen-reader and keyboard users to understand page structure and reach primary content efficiently.

Recommended Fixes:
Resolve critical and serious issues first, then moderate issues. Re-scan after each fix cycle and confirm with manual keyboard and screen-reader testing.`;
}

function cleanAiReportText(text) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/^"+|"+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseWebsiteReportSections(reportText) {
  const source = cleanAiReportText(reportText);
  const sectionTitles = [
    "Executive Summary",
    "What Passed",
    "What Failed",
    "Why It Matters",
    "Recommended Fixes"
  ];

  const indices = sectionTitles
    .map((title) => ({ title, index: source.indexOf(`${title}:`) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (indices.length === 0) {
    return sectionTitles.map((title, idx) => ({
      title,
      content: idx === 0 ? source : "Not provided."
    }));
  }

  return indices.map((current, idx) => {
    const start = current.index + current.title.length + 1;
    const end = idx + 1 < indices.length ? indices[idx + 1].index : source.length;
    const content = source.slice(start, end).trim();
    return { title: current.title, content: content || "Not provided." };
  });
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
  const [bluetoothLoading, setBluetoothLoading] = useState(false);
  const [knownBluetoothDevices, setKnownBluetoothDevices] = useState([]);
  const [selectedBluetoothDevice, setSelectedBluetoothDevice] = useState("");
  const [themeMode, setThemeMode] = useState("light");
  const [aiSummaryEnabled, setAiSummaryEnabled] = useState(true);
  const [aiVerbosity, setAiVerbosity] = useState("standard");
  const [lastRefreshedAt, setLastRefreshedAt] = useState("Not refreshed yet");
  const [reportText, setReportText] = useState("");
  const [summaryText, setSummaryText] = useState("Import measurements to auto-generate a report and readable summary.");
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
  const [websiteUrl, setWebsiteUrl] = useState("https://example.com");
  const [websiteScanLoading, setWebsiteScanLoading] = useState(false);
  const [websiteScanError, setWebsiteScanError] = useState("");
  const [websiteScanResult, setWebsiteScanResult] = useState(null);
  const [websiteReportText, setWebsiteReportText] = useState("");
  const [websiteReportLoading, setWebsiteReportLoading] = useState(false);
  const [savedWebsiteInspections, setSavedWebsiteInspections] = useState([]);
  const [selectedInspectionId, setSelectedInspectionId] = useState("");
  const [loadingSavedInspections, setLoadingSavedInspections] = useState(false);
  const [saveInspectionStatus, setSaveInspectionStatus] = useState("");
  const [saveInspectionError, setSaveInspectionError] = useState("");
  const [cloudStateReady, setCloudStateReady] = useState(false);
  const cloudStateLoadedRef = useRef(false);
  function buildReportMeasurements() {
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

    return sourceMeasurements.length > 0 ? sourceMeasurements : [fallbackMeasurement];
  }

  function buildRawReport(measurements) {
    return generateRawReport({
      buildingName,
      inspectorName,
      inspectionDate,
      notes: reportNotes,
      measurements,
      minDoorWidth,
      minSlopeRatio
    });
  }


  const doorPass = evaluateDoor(doorWidth, minDoorWidth);
  const rampPass = evaluateRamp(rampAngle, minSlopeRatio);
  const slopeRatio = calculateSlopeRatio(rampAngle);


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
    async function loadPreviouslyPairedDevices() {
      if (!("bluetooth" in navigator) || !navigator.bluetooth.getDevices) {
        return;
      }
      try {
        const pairedDevices = await navigator.bluetooth.getDevices();
        const deviceNames = pairedDevices
          .map((device, index) => device?.name || `Paired Device ${index + 1}`)
          .filter(Boolean);

        if (deviceNames.length === 0) return;

        setKnownBluetoothDevices((prev) =>
          [...new Set([...deviceNames, ...prev])].slice(0, 10)
        );
        setSelectedBluetoothDevice((prev) => prev || deviceNames[0]);
      } catch (_error) {
        // Ignore: some browsers block listing paired devices until permission is granted.
      }
    }

    loadPreviouslyPairedDevices();
  }, []);

  useEffect(() => {
    document.body.classList.toggle("theme-dark", themeMode === "dark");
    return () => document.body.classList.remove("theme-dark");
  }, [themeMode]);

  useEffect(() => {
    cloudStateLoadedRef.current = false;
    setCloudStateReady(false);

    if (!authUser?.uid) return;

    refreshSavedWebsiteInspections();
    loadPersistedDashboardState(authUser.uid);
  }, [authUser]);

  useEffect(() => {
    if (!authUser?.uid || !cloudStateReady) return;
    const timeoutId = setTimeout(() => {
      persistDashboardState();
    }, 700);
    return () => clearTimeout(timeoutId);
  }, [
    authUser?.uid,
    cloudStateReady,
    activeMenu,
    buildingName,
    inspectorName,
    inspectionDate,
    minSlopeRatio,
    minDoorWidth,
    doorWidth,
    rampAngle,
    knownBluetoothDevices,
    selectedBluetoothDevice,
    themeMode,
    aiSummaryEnabled,
    aiVerbosity,
    lastRefreshedAt,
    reportText,
    summaryText,
    reportNotes,
    compiledMeasurements,
    logs,
    importedReadings,
    websiteUrl,
    websiteReportText,
    selectedInspectionId
  ]);

  const selectedSavedInspection = useMemo(() => {
    return savedWebsiteInspections.find((item) => item.id === selectedInspectionId) || null;
  }, [savedWebsiteInspections, selectedInspectionId]);
  const remediationPrioritySites = useMemo(() => {
    return [...savedWebsiteInspections]
      .sort((a, b) => (b.counts?.violations || 0) - (a.counts?.violations || 0))
      .slice(0, 10);
  }, [savedWebsiteInspections]);

  function normalizeNumber(value, fallbackValue) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallbackValue;
  }

  async function loadPersistedDashboardState(userId) {
    try {
      const stateRef = doc(db, "users", userId, "dashboardState", "current");
      const snapshot = await getDoc(stateRef);
      if (!snapshot.exists()) {
        return;
      }

      const data = snapshot.data() || {};
      if (typeof data.activeMenu === "string") setActiveMenu(data.activeMenu);
      if (typeof data.buildingName === "string") setBuildingName(data.buildingName);
      if (typeof data.inspectorName === "string") setInspectorName(data.inspectorName);
      if (typeof data.inspectionDate === "string") setInspectionDate(data.inspectionDate);

      setMinSlopeRatio(normalizeNumber(data.minSlopeRatio, 12));
      setMinDoorWidth(normalizeNumber(data.minDoorWidth, 32));
      setDoorWidth(normalizeNumber(data.doorWidth, 29));
      setRampAngle(normalizeNumber(data.rampAngle, 6.2));

      if (Array.isArray(data.knownBluetoothDevices)) {
        setKnownBluetoothDevices(data.knownBluetoothDevices.slice(0, 10));
      }
      if (typeof data.selectedBluetoothDevice === "string") {
        setSelectedBluetoothDevice(data.selectedBluetoothDevice);
      }
      if (typeof data.themeMode === "string") setThemeMode(data.themeMode);

      if (typeof data.aiSummaryEnabled === "boolean") {
        setAiSummaryEnabled(data.aiSummaryEnabled);
      }
      if (typeof data.aiVerbosity === "string") {
        setAiVerbosity(data.aiVerbosity);
      }
      if (typeof data.lastRefreshedAt === "string") setLastRefreshedAt(data.lastRefreshedAt);
      if (typeof data.reportText === "string") setReportText(data.reportText);
      if (typeof data.summaryText === "string") setSummaryText(data.summaryText);
      if (typeof data.reportNotes === "string") setReportNotes(data.reportNotes);

      if (Array.isArray(data.compiledMeasurements)) {
        setCompiledMeasurements(data.compiledMeasurements.slice(0, 20));
      }
      if (Array.isArray(data.logs)) {
        setLogs(data.logs.slice(0, 50));
      }
      if (Array.isArray(data.importedReadings)) {
        setImportedReadings(data.importedReadings.slice(0, 30));
      }
      if (typeof data.websiteUrl === "string") setWebsiteUrl(data.websiteUrl);
      if (typeof data.websiteReportText === "string") setWebsiteReportText(data.websiteReportText);
      if (typeof data.selectedInspectionId === "string") {
        setSelectedInspectionId(data.selectedInspectionId);
      }
    } catch (error) {
      console.error("Unable to load dashboard state from Firestore", error);
    } finally {
      cloudStateLoadedRef.current = true;
      setCloudStateReady(true);
    }
  }

  async function persistDashboardState() {
    if (!authUser?.uid || !cloudStateLoadedRef.current) return;
    try {
      const stateRef = doc(db, "users", authUser.uid, "dashboardState", "current");
      await setDoc(
        stateRef,
        {
          activeMenu,
          buildingName,
          inspectorName,
          inspectionDate,
          minSlopeRatio,
          minDoorWidth,
          doorWidth,
          rampAngle,
          knownBluetoothDevices: knownBluetoothDevices.slice(0, 10),
          selectedBluetoothDevice,
          themeMode,
          aiSummaryEnabled,
          aiVerbosity,
          lastRefreshedAt,
          reportText,
          summaryText,
          reportNotes,
          compiledMeasurements: compiledMeasurements.slice(0, 20),
          logs: logs.slice(0, 50),
          importedReadings: importedReadings.slice(0, 30),
          websiteUrl,
          websiteReportText,
          selectedInspectionId,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Unable to save dashboard state to Firestore", error);
    }
  }

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
      setBluetoothLoading(true);
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
    } finally {
      setBluetoothLoading(false);
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

  async function generateSummary(rawReportOverride, measurementsOverride) {
    if (!aiSummaryEnabled) {
      setSummaryText("AI summary is disabled in Settings.");
      return;
    }

    const measurements =
      measurementsOverride ||
      (compiledMeasurements.length > 0 ? compiledMeasurements : buildReportMeasurements());

    const rawReport = rawReportOverride || reportText || buildRawReport(measurements);

    const fallbackSummary = summarizeReport({
      buildingName,
      measurements,
      minDoorWidth,
      minSlopeRatio,
      verbosity: aiVerbosity
    });

    if (!rawReport.trim()) {
      setSummaryText(fallbackSummary);
      return;
    }

    try {
      setSummaryLoading(true);
      const aiSummary = await generateAiSummary({
        rawReport,
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

  function generateReportFromLatestData() {
    const measurements = buildReportMeasurements();
    const rawReport = buildRawReport(measurements);
    setCompiledMeasurements(measurements);
    setReportText(rawReport);
    return { rawReport, measurements };
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

  async function scanWebsiteAccessibility() {
    setWebsiteScanError("");
    setWebsiteScanResult(null);
    setWebsiteReportText("");

    if (!websiteUrl.trim()) {
      setWebsiteScanError("Please enter a website URL.");
      return;
    }

    try {
      setWebsiteScanLoading(true);
      const response = await fetch("/api/websites/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: websiteUrl.trim() })
      });

      const rawBody = await response.text();
      let payload = {};
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (_error) {
        payload = {};
      }

      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      if (!isJson && response.ok) {
        throw new Error(
          "Website scan API is unavailable for this deployment. Run locally with `npm run dev`, or point `/api` to your backend scanner service."
        );
      }

      if (!response.ok) {
        const bodySnippet = rawBody ? rawBody.slice(0, 140).replace(/\s+/g, " ").trim() : "";
        throw new Error(
          payload.details
            ? `${payload.error || "Website scan failed."} ${payload.details}`
            : payload.error ||
                (bodySnippet
                  ? `Website scan failed. ${bodySnippet}`
                  : "Website scan failed.")
        );
      }

      setWebsiteScanResult(payload);
      setWebsiteReportText(cleanAiReportText(generateWebsiteFallbackReport(payload)));
    } catch (error) {
      setWebsiteScanError(error.message || "Unable to scan website.");
    } finally {
      setWebsiteScanLoading(false);
    }
  }

  async function generateWebsiteAiNarrative() {
    if (!websiteScanResult) {
      setWebsiteScanError("Run a scan first, then generate the AI report.");
      return;
    }

    try {
      setWebsiteReportLoading(true);
      setWebsiteScanError("");
      const aiReport = await generateAiWebsiteReport({
        url: websiteScanResult.url,
        counts: websiteScanResult.counts,
        violations: websiteScanResult.violations || []
      });
      setWebsiteReportText(cleanAiReportText(aiReport));
    } catch (error) {
      setWebsiteScanError(`AI report fallback: ${error.message}`);
      setWebsiteReportText(cleanAiReportText(generateWebsiteFallbackReport(websiteScanResult)));
    } finally {
      setWebsiteReportLoading(false);
    }
  }

  async function refreshSavedWebsiteInspections() {
    if (!authUser?.uid) return;
    setLoadingSavedInspections(true);
    setSaveInspectionError("");
    try {
      const inspectionsRef = collection(db, "users", authUser.uid, "websiteInspections");
      const inspectionsQuery = query(inspectionsRef, orderBy("createdAt", "desc"), limit(200));
      const snapshot = await getDocs(inspectionsQuery);
      const records = snapshot.docs.map((docSnapshot) => {
        const data = docSnapshot.data();
        const createdAtDate = data.createdAt?.toDate?.() || null;
        return {
          id: docSnapshot.id,
          ...data,
          createdAtLabel: createdAtDate
            ? createdAtDate.toLocaleString()
            : data.scannedAt
              ? new Date(data.scannedAt).toLocaleString()
              : "Unknown time"
        };
      });
      setSavedWebsiteInspections(records);
      if (records.length === 0) {
        setSelectedInspectionId("");
      } else if (!selectedInspectionId || !records.some((item) => item.id === selectedInspectionId)) {
        setSelectedInspectionId(records[0].id);
      }
    } catch (error) {
      setSaveInspectionError(`Unable to refresh saved inspections: ${error.message}`);
    } finally {
      setLoadingSavedInspections(false);
    }
  }

  async function saveWebsiteInspectionLog() {
    if (!authUser?.uid) {
      setSaveInspectionError("You must be signed in to save inspection logs.");
      return;
    }
    if (!websiteScanResult) {
      setSaveInspectionError("Run a website scan first.");
      return;
    }

    setSaveInspectionError("");
    setSaveInspectionStatus("");
    try {
      const inspectionsRef = collection(db, "users", authUser.uid, "websiteInspections");
      await addDoc(inspectionsRef, {
        url: websiteScanResult.url,
        scannedAt: websiteScanResult.scannedAt,
        counts: websiteScanResult.counts || {},
        failedChecks: websiteScanResult.failedChecks || [],
        passedChecks: websiteScanResult.passedChecks || [],
        violations: websiteScanResult.violations || [],
        reportText:
          cleanAiReportText(websiteReportText) ||
          cleanAiReportText(generateWebsiteFallbackReport(websiteScanResult)),
        createdAt: serverTimestamp()
      });
      setSaveInspectionStatus("Inspection log saved to Firestore.");
      await refreshSavedWebsiteInspections();
    } catch (error) {
      setSaveInspectionError(`Unable to save inspection log: ${error.message}`);
    }
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
                <p className="stat-title">Saved Scans</p>
                <p className="stat-value">{savedWebsiteInspections.length}</p>
                <p className="stat-meta">Website accessibility inspections</p>
              </article>
              <article className="stat-card">
                <p className="stat-title">Needs Remediation</p>
                <p className="stat-value">
                  {
                    savedWebsiteInspections.filter((item) => (item.counts?.violations || 0) > 0)
                      .length
                  }
                </p>
                <p className="stat-meta">Sites with one or more violations</p>
              </article>
            </section>

            <section className="panel-grid">
              <article className="panel">
                <h3>Selected Inspection Summary</h3>
                <p>Pick a saved scan to review key findings.</p>
                <div className="row">
                  <select
                    value={selectedInspectionId}
                    onChange={(event) => setSelectedInspectionId(event.target.value)}
                    style={{ minHeight: "42px", minWidth: "300px" }}
                  >
                    <option value="">Select saved inspection</option>
                    {savedWebsiteInspections.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.url} - {item.createdAtLabel}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-outline"
                    onClick={refreshSavedWebsiteInspections}
                    disabled={loadingSavedInspections}
                  >
                    {loadingSavedInspections ? "Refreshing..." : "Refresh Saved Data"}
                  </button>
                </div>
                {selectedSavedInspection ? (
                  <div className="summary-box" style={{ marginTop: "10px" }}>
                    <strong>{selectedSavedInspection.url}</strong>
                    {"\n"}Captured: {selectedSavedInspection.createdAtLabel}
                    {"\n"}Violations: {selectedSavedInspection.counts?.violations || 0}
                    {"\n"}Passed checks: {selectedSavedInspection.counts?.passes || 0}
                    {"\n\n"}
                    {cleanAiReportText(
                      selectedSavedInspection.reportText || "No narrative saved for this inspection."
                    )}
                  </div>
                ) : (
                  <p style={{ marginTop: "10px" }}>
                    No saved selection yet. Save a scan in the Websites tab, then choose it here.
                  </p>
                )}
              </article>

              <article className="panel">
                <h3>Top Remediation Priority Sites</h3>
                <table className="log-table">
                  <thead>
                    <tr>
                      <th>Website</th>
                      <th>Violations</th>
                      <th>Passed</th>
                      <th>Captured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {remediationPrioritySites.length === 0 ? (
                      <tr>
                        <td colSpan="4">No saved website inspections yet.</td>
                      </tr>
                    ) : (
                      remediationPrioritySites.map((item) => (
                        <tr key={item.id}>
                          <td>{item.url}</td>
                          <td className={(item.counts?.violations || 0) > 0 ? "bad" : "ok"}>
                            {item.counts?.violations || 0}
                          </td>
                          <td>{item.counts?.passes || 0}</td>
                          <td>{item.createdAtLabel}</td>
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
              <h3>Inspection Report</h3>
              <p>
                This report auto-builds from the latest imported/saved measurements. You do not
                need to manually enter values here.
              </p>
              <div className="summary-box">{reportText || "Import data to generate report."}</div>
              <div className="row" style={{ marginTop: "10px" }}>
                <button className="btn btn-outline" onClick={generateReportFromLatestData}>
                  Generate Report
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
              <p>Readable explanation generated from the latest report data.</p>
              <div className="summary-box">{summaryText}</div>
              <div className="row" style={{ marginTop: "10px" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => generateSummary()}
                  disabled={!aiSummaryEnabled || summaryLoading}
                >
                  {summaryLoading ? "Generating..." : "Regenerate AI Summary"}
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
              <p>Set your project defaults once so every report uses clear, consistent values.</p>

              <div className="settings-grid">
                <section className="settings-section">
                  <h4>Inspection Profile</h4>
                  <p className="settings-helper">Basic report identity fields shown in generated reports.</p>
                  <div className="row">
                    <label className="input-label">
                      Building Name
                      <input
                        type="text"
                        value={buildingName}
                        onChange={(event) => setBuildingName(event.target.value)}
                        placeholder="e.g., City Hall"
                      />
                    </label>
                    <label className="input-label">
                      Inspector Name
                      <input
                        type="text"
                        value={inspectorName}
                        onChange={(event) => setInspectorName(event.target.value)}
                        placeholder="e.g., Omar M."
                      />
                    </label>
                    <label className="input-label">
                      Inspection Date
                      <input
                        type="date"
                        value={inspectionDate}
                        onChange={(event) => setInspectionDate(event.target.value)}
                      />
                    </label>
                  </div>
                </section>

                <section className="settings-section">
                  <h4>ADA Thresholds</h4>
                  <p className="settings-helper">
                    These are the compliance cutoffs used in pass/fail checks.
                  </p>
                  <div className="row">
                    <label className="input-label">
                      Ramp Standard (1:X ratio)
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={minSlopeRatio}
                        onChange={(event) => setMinSlopeRatio(Number(event.target.value))}
                        placeholder="12"
                      />
                    </label>
                    <label className="input-label">
                      Minimum Door Width (inches)
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={minDoorWidth}
                        onChange={(event) => setMinDoorWidth(Number(event.target.value))}
                        placeholder="32"
                      />
                    </label>
                  </div>
                  <p className="stat-meta">
                    Example: <strong>1:12</strong> means for every 12 inches of run, ramp rises 1 inch.
                    Door width should typically be at least <strong>32 in</strong>.
                  </p>
                </section>

                <section className="settings-section">
                  <h4>Bluetooth Device</h4>
                  <p className="settings-helper">Choose the previously paired sensor source for imports.</p>
                  <div className="row settings-device-row">
                    <label className="input-label">
                      Device
                      <select
                        value={selectedBluetoothDevice}
                        onChange={(event) => setSelectedBluetoothDevice(event.target.value)}
                      >
                        <option value="">
                          {knownBluetoothDevices.length > 0 ? "Select device" : "No paired devices yet"}
                        </option>
                        {knownBluetoothDevices.map((deviceName) => (
                          <option key={deviceName} value={deviceName}>
                            {deviceName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn btn-outline settings-device-btn"
                      onClick={connectBluetooth}
                      disabled={bluetoothLoading}
                    >
                      {bluetoothLoading ? "Pairing..." : "Add Device"}
                    </button>
                  </div>
                  <p className="stat-meta">Selected device: {selectedBluetoothDevice || "None selected"}</p>
                </section>

                <section className="settings-section">
                  <h4>Appearance</h4>
                  <p className="settings-helper">Switch UI theme for your workspace and presentations.</p>
                  <div className="row">
                    <label className="input-label">
                      Theme
                      <select value={themeMode} onChange={(event) => setThemeMode(event.target.value)}>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </label>
                  </div>
                </section>
              </div>
            </article>
          </section>
        )}

        {activeMenu === "Websites" && (
          <section style={{ marginTop: "14px" }}>
            <article className="panel">
              <h3>Website Accessibility Scanner</h3>
              <p>Scan a URL and generate a presentation-ready accessibility report.</p>
              <div className="row">
                <input
                  type="url"
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  placeholder="https://example.com"
                />
                <button
                  className="btn btn-primary"
                  onClick={scanWebsiteAccessibility}
                  disabled={websiteScanLoading}
                >
                  {websiteScanLoading ? "Scanning..." : "Scan Website"}
                </button>
              </div>
              {websiteScanError && (
                <p className="status-error" style={{ marginTop: "10px" }}>
                  {websiteScanError}
                </p>
              )}
              {websiteScanResult && (
                <>
                  <div className="row" style={{ marginTop: "10px" }}>
                    <span className="badge">Violations: {websiteScanResult.counts?.violations ?? 0}</span>
                    <span className="badge">Passes: {websiteScanResult.counts?.passes ?? 0}</span>
                  </div>
                  <div className="row" style={{ marginTop: "10px" }}>
                    <button
                      className="btn btn-outline"
                      onClick={generateWebsiteAiNarrative}
                      disabled={websiteReportLoading}
                    >
                      {websiteReportLoading ? "Generating Detailed Report..." : "Generate Detailed AI Report"}
                    </button>
                    <button className="btn btn-primary" onClick={saveWebsiteInspectionLog}>
                      Save Inspection Log
                    </button>
                  </div>
                  <div className="website-report-grid" style={{ marginTop: "10px" }}>
                    {parseWebsiteReportSections(
                      websiteReportText || generateWebsiteFallbackReport(websiteScanResult)
                    ).map((section) => (
                      <article key={section.title} className="report-card">
                        <h4>{section.title}</h4>
                        <p>{section.content}</p>
                      </article>
                    ))}
                  </div>
                  {(websiteScanResult.failedChecks || []).length > 0 &&
                    (websiteScanResult.passedChecks || []).length > 0 && (
                      <div className="website-checks-grid" style={{ marginTop: "10px" }}>
                        <article className="panel">
                          <h3>Top Failed Checks</h3>
                          <ul className="checks-list">
                            {websiteScanResult.failedChecks.slice(0, 5).map((item) => (
                              <li key={`fail-${item.id}`}>
                                <span className={`metric-result ${formatImpactClass(item.impact)}`}>
                                  {String(item.impact || "unknown").toUpperCase()}
                                </span>{" "}
                                {item.help}
                              </li>
                            ))}
                          </ul>
                        </article>
                        <article className="panel">
                          <h3>Top Passed Checks</h3>
                          <ul className="checks-list">
                            {websiteScanResult.passedChecks.slice(0, 5).map((item) => (
                              <li key={`pass-${item.id}`}>
                                <span className="metric-result ok">PASSED</span> {item.help}
                              </li>
                            ))}
                          </ul>
                        </article>
                      </div>
                    )}
                </>
              )}
            </article>
          </section>
        )}
      </main>
    </div>
  );
}
