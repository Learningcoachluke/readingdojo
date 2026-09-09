// Generates a fresh PIN for a student and sets it as their Auth password.
// This is the only way to "see" a PIN after creation — passwords are
// hashed, so an existing one can never be looked up, only replaced.

const { requireAdminId } = require("./_lib/requireAdmin");
const { setAuthUserPassword, randomPin } = require("./_lib/authAdmin");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    await requireAdminId(event);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const studentId = body.studentId;
    if (!studentId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing studentId." }) };
    }

    const pin = randomPin();
    await setAuthUserPassword(studentId, pin);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
