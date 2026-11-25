const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { Readable } = require("node:stream");
const SecurityRateLimit = require("../model/security-rate-limit.model");
const router = require("../router/router");
const { uploadImage, MAX_IMAGE_BYTES } = require("../controller/image-upload.controller");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64");
const responseRecorder = {
  status(code) {
    return { json: (body) => ({ code, body }) };
  },
};

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("image upload keeps the key in the server request body and returns only the public URL", async (t) => {
  setEnv(t, "IMGBB_API_KEY", "private-test-key");
  t.mock.method(axios, "post", async (url, body, config) => {
    assert.equal(url, "https://api.imgbb.com/1/upload");
    const form = new URLSearchParams(body);
    assert.equal(form.get("key"), "private-test-key");
    assert.equal(form.get("image"), png.toString("base64"));
    assert.equal(config.maxRedirects, 0);
    return { data: { success: true, data: { url: "https://i.ibb.co/example/image.png", delete_url: "private-delete-link" } } };
  });
  const result = await uploadImage({ body: png }, responseRecorder);
  assert.equal(result.code, 201);
  assert.deepEqual(result.body.innerData, { imageUrl: "https://i.ibb.co/example/image.png" });
  assert.doesNotMatch(JSON.stringify(result), /private-test-key|private-delete-link/);
});

test("invalid, empty, URL, SVG, and oversized uploads never reach the provider", async (t) => {
  setEnv(t, "IMGBB_API_KEY", "private-test-key");
  const post = t.mock.method(axios, "post", async () => { throw new Error("unexpected provider call"); });
  for (const body of [null, {}, Buffer.alloc(0), Buffer.from("https://example.com/image.png"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
    assert.equal((await uploadImage({ body }, responseRecorder)).code, 400);
  }
  assert.equal((await uploadImage({ body: Buffer.alloc(MAX_IMAGE_BYTES + 1) }, responseRecorder)).code, 413);
  assert.equal(post.mock.callCount(), 0);
});

test("missing server configuration cannot fall back to a client key", async (t) => {
  setEnv(t, "IMGBB_API_KEY", undefined);
  setEnv(t, "VITE_IMGBB_API_KEY", "exposed-client-key");
  const post = t.mock.method(axios, "post", async () => { throw new Error("unexpected provider call"); });
  assert.equal((await uploadImage({ body: png }, responseRecorder)).code, 500);
  assert.equal(post.mock.callCount(), 0);
});

test("provider failures and malformed responses do not leak credentials", async (t) => {
  setEnv(t, "IMGBB_API_KEY", "private-test-key");
  const post = t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("private-test-key"), { response: { data: { key: "private-test-key" } } });
  });
  const failed = await uploadImage({ body: png }, responseRecorder);
  assert.equal(failed.code, 502);
  assert.doesNotMatch(JSON.stringify(failed), /private-test-key/);
  for (const url of ["", "http://i.ibb.co/image.png", "https://evil.example/image.png", "https://i.ibb.co.evil.example/image.png"]) {
    post.mock.mockImplementation(async () => ({ data: { success: true, data: { url } } }));
    assert.equal((await uploadImage({ body: png }, responseRecorder)).code, 502);
  }
});

function dispatchUpload({ token, sessionId = "123", body = png, contentType = "image/png" } = {}) {
  const route = router.stack.find((layer) => layer.route?.path === "/admin/images/upload").route;
  const req = Readable.from([body]);
  req.method = "POST";
  req.headers = {
    "content-type": contentType,
    "content-length": String(body.length),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  req.telegramAuth = { tgUserId: sessionId };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ code: this.statusCode, body: payload }); },
    };
    route.dispatch(req, res, (error) => reject(error || new Error("Upload did not respond")));
  });
}

test("upload route requires an admin token bound to the Telegram session before contacting ImgBB", async (t) => {
  setEnv(t, "JWT_SECRET_KEY", "test-only-jwt-secret");
  const post = t.mock.method(axios, "post", async () => { throw new Error("unexpected provider call"); });
  const token = (role, tgUserId) => jwt.sign({ role, tgUserId }, process.env.JWT_SECRET_KEY, { issuer: "yamaha-api", audience: "yamaha-admin" });
  assert.equal((await dispatchUpload()).code, 401);
  assert.equal((await dispatchUpload({ token: token("user", "123") })).code, 403);
  assert.equal((await dispatchUpload({ token: token("admin", "456") })).code, 401);
  assert.equal(post.mock.callCount(), 0);
});

test("authenticated route enforces the rate and body limits and accepts an image", async (t) => {
  setEnv(t, "JWT_SECRET_KEY", "test-only-jwt-secret");
  setEnv(t, "IMGBB_API_KEY", "private-test-key");
  const token = jwt.sign({ role: "admin", tgUserId: "123" }, process.env.JWT_SECRET_KEY, { issuer: "yamaha-api", audience: "yamaha-admin" });
  const rate = t.mock.method(SecurityRateLimit, "findOneAndUpdate", () => ({ lean: async () => ({ count: 21 }) }));
  const post = t.mock.method(axios, "post", async () => ({ data: { success: true, data: { url: "https://i.ibb.co/example/image.png" } } }));
  assert.equal((await dispatchUpload({ token })).code, 429);
  assert.equal(post.mock.callCount(), 0);
  rate.mock.mockImplementation(() => ({ lean: async () => ({ count: 1 }) }));
  assert.equal((await dispatchUpload({ token, body: Buffer.alloc(MAX_IMAGE_BYTES + 1) })).code, 413);
  assert.equal(post.mock.callCount(), 0);
  assert.equal((await dispatchUpload({ token })).code, 201);
  assert.equal(post.mock.callCount(), 1);
});
