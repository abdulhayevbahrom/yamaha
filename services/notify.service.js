const { EventEmitter } = require("events");

const emitter = new EventEmitter();

const notifyGamePaid = (payload) => {
  emitter.emit("game-paid", payload);
};

const onGamePaid = (handler) => {
  emitter.on("game-paid", handler);
};

const notifyUcPaid = notifyGamePaid;
const onUcPaid = onGamePaid;

module.exports = {
  notifyGamePaid,
  onGamePaid,
  notifyUcPaid,
  onUcPaid,
};
