const test = require("node:test");
const assert = require("node:assert/strict");
const { createProfileHandler } = require("./profile");

test("Client profile updates leave identifiers and legacy metadata intact", async () => {
  const calls = [];
  const handler = createProfileHandler({
    findByIdAndUpdate(id, update, options) {
      calls.push({ id, update, options });
      return {
        select(fields) {
          assert.ok(!fields.includes("raw") && !fields.includes("otp"));
          return { lean: async () => ({ _id: id, vendorCode: "PIL", ...update.$set }) };
        },
      };
    },
  });
  const id = "000000000000000000000001";
  const response = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ params: { id }, body: {
    name: " Updated client ", email: "HR@EXAMPLE.TEST",
    vendorCode: "ALTERED", status: "Inactive", raw: { should: "not update" },
  } }, response);
  assert.deepEqual(calls, [{
    id, update: { $set: { name: "Updated client", email: "hr@example.test" } },
    options: { new: true, runValidators: true },
  }]);
  assert.equal(response.body.data.vendorCode, "PIL");
  await handler({ params: { id }, body: { name: " " } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 1);
});
