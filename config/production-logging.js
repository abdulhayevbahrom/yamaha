"use strict";

// PM2 writes stdout to /dev/null in production. Route application warnings to
// stdout as well so that only real errors remain in PM2's error log.
if (process.env.NODE_ENV === "production") {
  console.warn = console.log.bind(console);
}
