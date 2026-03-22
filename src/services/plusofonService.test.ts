import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { env } from "../config/env";
import { plusofonService } from "./plusofonService";

test("plusofonService.requestCallToAuth always returns the requested phone instead of provider callback number", async () => {
  const originalPost = axios.post;
  const originalAccessToken = env.plusofonFlashAccessToken;
  env.plusofonFlashAccessToken = "test-plusofon-token";

  (axios.post as unknown as typeof axios.post) = (async () => ({
    data: {
      request_id: "provider-req-1",
      phone: "79675180038",
      call_to_auth_number: "79675180038",
    },
    headers: {},
  })) as typeof axios.post;

  try {
    const result = await plusofonService.requestCallToAuth("+79778117527");

    assert.equal(result.requestId, "provider-req-1");
    assert.equal(result.callToAuthNumber, "79675180038");
    assert.equal(result.phone, "+79778117527");
  } finally {
    env.plusofonFlashAccessToken = originalAccessToken;
    (axios.post as unknown as typeof axios.post) = originalPost;
  }
});
