const { EventEmitter } = require("events");

const emitter = new EventEmitter();

const notifyUcPaid = (payload) => {
  emitter.emit("uc-paid", payload);
};

const onUcPaid = (handler) => {
  emitter.on("uc-paid", handler);
};

module.exports = {
  notifyUcPaid,
  onUcPaid,
};
