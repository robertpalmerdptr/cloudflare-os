import { expect, it } from "vitest";
import { connect } from "../src/rpc-client.js";

it("rejects an Access token over a plaintext WebSocket", () => {
  expect(() => connect(new URL("http://127.0.0.1:8787"), {
    accessToken: "access.jwt.value",
  })).toThrow("HTTPS");
});
