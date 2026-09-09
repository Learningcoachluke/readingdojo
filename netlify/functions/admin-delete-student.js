// Permanently deletes a student's auth user — cascades to their profile,
// reading sessions, and everything else via the schema's ON DELETE CASCADE.

const { requireAdminId } = require("./_lib/requireAdmin");
const { deleteAuthUser } = require("./_lib/authAdmin");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const adminId = await requireAdminId(event);

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
    if (studentId === adminId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Can't delete your own account here." }) };
    }

    await deleteAuthUser(studentId);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: true }) };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
