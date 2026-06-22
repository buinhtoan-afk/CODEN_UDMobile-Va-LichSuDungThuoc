const express = require("express");
const { query } = require("../db/connection");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function mapPatient(row) {
  return {
    id: row.Id,
    code: row.Code,
    name: row.Name,
    phone: row.Phone,
    birth: row.Birth ? row.Birth.toISOString().slice(0, 10) : null,
    gender: row.Gender,
    department: row.Department,
    status: row.Status,
    lastVisit: row.LastVisit ? row.LastVisit.toISOString().slice(0, 10) : null,
    note: row.Note,
  };
}

function mapRx(row) {
  let times = [];
  try {
    times = row.TimesJson ? JSON.parse(row.TimesJson) : [];
  } catch (_) {}
  return {
    id: row.Id,
    name: row.Name,
    dosage: row.Dosage,
    frequency: row.Frequency,
    intakeTime: row.IntakeTime,
    times,
    status: row.Status,
    startDate: row.StartDate ? row.StartDate.toISOString().slice(0, 10) : null,
    endDate: row.EndDate ? row.EndDate.toISOString().slice(0, 10) : null,
    note: row.Note,
    runningOut: !!row.RunningOut,
  };
}

function mapNotif(row) {
  return {
    id: row.Id,
    title: row.Title,
    message: row.Message,
    type: row.Type,
    icon: row.Icon,
    read: !!row.IsRead,
    at: row.At,
  };
}

router.get("/", requireAuth, requireRole("user"), async (req, res) => {
  try {
    const userId = req.user.Id;
    const userName = req.user.Name || "";

    const linkedResult = await query("SELECT * FROM dbo.Patients WHERE UserId = @userId", { userId });
    const linked = linkedResult.recordset[0] || null;

    const unlinkedResult = await query(
      `SELECT * FROM dbo.Patients
       WHERE UserId IS NULL
         AND LOWER(LTRIM(RTRIM(Name))) = LOWER(LTRIM(RTRIM(@name)))`,
      { name: userName }
    );

    const patientMap = new Map();
    if (linked) patientMap.set(linked.Id, linked);
    unlinkedResult.recordset.forEach((row) => {
      if (!patientMap.has(row.Id)) patientMap.set(row.Id, row);
    });

    // Tự gắn hồ sơ BN (admin tạo) với tài khoản user nếu cùng tên và chưa có hồ sơ gắn sẵn
    if (!linked && unlinkedResult.recordset.length === 1) {
      const row = unlinkedResult.recordset[0];
      await query(
        "UPDATE dbo.Patients SET UserId = @userId, UpdatedAt = SYSUTCDATETIME() WHERE Id = @id",
        { userId, id: row.Id }
      );
      row.UserId = userId;
      patientMap.set(row.Id, row);
    }

    const patients = [...patientMap.values()];
    const patient = linked || patients[0] || null;

    if (!patients.length) {
      return res.json({
        patient: null,
        prescriptions: [],
        scheduleToday: [],
        notifications: [],
        message: "Chưa có hồ sơ bệnh nhân liên kết. Liên hệ bác sĩ để được kê đơn.",
      });
    }

    const patientIds = patients.map((p) => p.Id);
    let prescriptions = [];
    for (const patientId of patientIds) {
      const rxResult = await query(
        "SELECT * FROM dbo.Prescriptions WHERE PatientId = @patientId ORDER BY CreatedAt DESC",
        { patientId }
      );
      prescriptions = prescriptions.concat(rxResult.recordset.map(mapRx));
    }
    const rxSeen = new Set();
    prescriptions = prescriptions.filter((rx) => {
      if (rxSeen.has(rx.id)) return false;
      rxSeen.add(rx.id);
      return true;
    });

    const todayTimes = [];
    prescriptions
      .filter((r) => r.status === "active" || r.status === "pending")
      .forEach((rx) => {
        (rx.times || []).forEach((time) => {
          todayTimes.push({ time, drugName: rx.name, dosage: rx.dosage, rxId: rx.id });
        });
      });
    todayTimes.sort((a, b) => a.time.localeCompare(b.time));

    const notifResult = await query(
      "SELECT TOP 20 * FROM dbo.Notifications ORDER BY At DESC"
    );

    res.json({
      patient: mapPatient(patient),
      prescriptions,
      scheduleToday: todayTimes,
      notifications: notifResult.recordset.map(mapNotif),
    });
  } catch (err) {
    res.status(500).json({ error: "ServerError", message: err.message });
  }
});

module.exports = router;
