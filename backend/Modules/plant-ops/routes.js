const { createPlantOpsRouter } = require("./router");
const store = require("./store");

// backend/index.js mounts this module at /api/plant-ops automatically.
module.exports = createPlantOpsRouter(store);
