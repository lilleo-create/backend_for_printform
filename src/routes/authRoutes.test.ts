import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { authRoutes } from "./authRoutes";
import { errorHandler } from "../middleware/errorHandler";
import { userRepository } from "../repositories/userRepository";
import { deviceTrustService } from "../services/deviceTrustService";
import { authService } from "../services/authService";
import { otpService } from "../services/otpService";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/auth", authRoutes);
  app.use(errorHandler);
  return app;
};

const originalTrustedDeviceFlag = env.authTrustedDeviceEnforced;
(prisma.phoneOtp.findFirst as any) = async () => null;
(prisma.pendingRegistration.findUnique as any) = async () => null;

const baseUser = {
  id: "user-1",
  role: "BUYER" as const,
  name: "Test",
  fullName: "Test User",
  email: "test@example.com",
  phone: "+79991234567",
  address: null,
  phoneVerifiedAt: new Date("2026-03-22T00:00:00.000Z"),
  passwordHash: "hashed-password",
};

test.afterEach(() => {
  env.authTrustedDeviceEnforced = originalTrustedDeviceFlag;
  (prisma.phoneOtp.findFirst as any) = async () => null;
  (prisma.pendingRegistration.findUnique as any) = async () => null;
});

test("POST /auth/otp/request returns registration verification data for the current registration phone even if provider responds with another phone", async () => {
  const registrationSessionId = "pending-reg-1";
  const tempToken = authService.issueRegistrationOtpToken(registrationSessionId);
  (prisma.pendingRegistration.findUnique as any) = async ({
    where,
  }: {
    where: { id: string };
  }) => {
    assert.equal(where.id, registrationSessionId);
    return {
      id: registrationSessionId,
      phone: "+79778117527",
      usedAt: null,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    };
  };
  (otpService.requestOtp as unknown as (payload: {
    phone: string;
    purpose: string;
  }) => Promise<{
    ok: true;
    data: {
      requestId: string;
      phone: string;
      provider: "plusofon";
      verificationType: "call_to_auth";
      callToAuthNumber: string | null;
    };
  }>) = async (payload) => {
    assert.equal(payload.phone, "+7 (977) 811-75-27");
    assert.equal(payload.purpose, "buyer_register_phone");
    return {
      ok: true,
      data: {
        requestId: "reg-req-1",
        phone: "+79778117527",
        provider: "plusofon",
        verificationType: "call_to_auth",
        callToAuthNumber: "79675180038",
      },
    };
  };

  const response = await request(buildApp())
    .post("/auth/otp/request")
    .set("Authorization", `Bearer ${tempToken}`)
    .send({
      phone: "+7 (977) 811-75-27",
      purpose: "buyer_register_phone",
    });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: {
      requestId: "reg-req-1",
      verificationType: "call_to_auth",
      callToAuthNumber: "79675180038",
      phone: "+79778117527",
      provider: "plusofon",
    },
  });
});

test("POST /auth/otp/request rejects stale registration phone from a previous attempt", async () => {
  const registrationSessionId = "pending-reg-2";
  const tempToken = authService.issueRegistrationOtpToken(registrationSessionId);
  let requestOtpCalls = 0;
  (prisma.pendingRegistration.findUnique as any) = async () => ({
    id: registrationSessionId,
    phone: "+79778117527",
    usedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  (otpService.requestOtp as unknown as () => Promise<never>) = async () => {
    requestOtpCalls += 1;
    throw new Error("requestOtp should not run when registration phone mismatches");
  };

  const response = await request(buildApp())
    .post("/auth/otp/request")
    .set("Authorization", `Bearer ${tempToken}`)
    .send({
      phone: "+7 (999) 123-45-67",
      purpose: "buyer_register_phone",
    });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "PHONE_MISMATCH");
  assert.equal(requestOtpCalls, 0);
});

test("POST /auth/otp/request keeps registration and login phone state isolated", async () => {
  env.authTrustedDeviceEnforced = true;
  let requestOtpCalls = 0;
  let loginStageCompleted = false;
  const registrationSessionId = "pending-reg-3";
  const registrationToken = authService.issueRegistrationOtpToken(
    registrationSessionId,
  );
  (deviceTrustService.cleanupExpired as unknown as () => Promise<void>) =
    async () => {};
  (deviceTrustService.findTrustedDeviceForRequest as unknown as () => Promise<null>) =
    async () => null;
  (authService.login as unknown as () => Promise<{ user: typeof baseUser }>) =
    async () => ({ user: baseUser });
  (prisma.pendingRegistration.findUnique as any) = async ({
    where,
  }: {
    where: { id: string };
  }) => {
    assert.equal(where.id, registrationSessionId);
    return {
      id: registrationSessionId,
      phone: "+79778117527",
      usedAt: null,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    };
  };
  (otpService.requestOtp as unknown as (payload: {
    phone: string;
    purpose: string;
  }) => Promise<any>) = async (payload) => {
    requestOtpCalls += 1;
    if (payload.purpose === "login_device") {
      loginStageCompleted = true;
      assert.equal(payload.phone, "+79991234567");
      return {
        ok: true,
        data: {
          requestId: "login-req-1",
          phone: "+79991234567",
          provider: "plusofon",
          verificationType: "call_to_auth",
          callToAuthNumber: "+78005553535",
        },
      };
    }
    assert.equal(loginStageCompleted, true);
    assert.equal(payload.purpose, "buyer_register_phone");
    assert.equal(payload.phone, "+7 (977) 811-75-27");
    return {
      ok: true,
      data: {
        requestId: "reg-req-2",
        phone: "+79778117527",
        provider: "plusofon",
        verificationType: "call_to_auth",
        callToAuthNumber: "79675180038",
      },
    };
  };

  const loginResponse = await request(buildApp())
    .post("/auth/login")
    .send({ phone: "+7 (999) 123-45-67", password: "secret123" });
  assert.equal(loginResponse.status, 403);
  assert.equal(loginResponse.body.phone, "+79991234567");

  const registrationResponse = await request(buildApp())
    .post("/auth/otp/request")
    .set("Authorization", `Bearer ${registrationToken}`)
    .send({
      phone: "+7 (977) 811-75-27",
      purpose: "buyer_register_phone",
    });
  assert.equal(registrationResponse.status, 200);
  assert.equal(registrationResponse.body.data.phone, "+79778117527");
  assert.equal(requestOtpCalls, 2);
});

test("POST /auth/login returns 400 with friendly message for invalid credentials and does not issue session cookies", async () => {
  env.authTrustedDeviceEnforced = false;
  let cleanupCalls = 0;
  let findTrustedCalls = 0;
  (deviceTrustService.cleanupExpired as any) = async () => {
    cleanupCalls += 1;
  };
  (deviceTrustService.findTrustedDeviceForRequest as any) = async () => {
    findTrustedCalls += 1;
    return null;
  };
  (authService.login as any) = async () => {
    throw new Error("INVALID_CREDENTIALS");
  };

  const response = await request(buildApp())
    .post("/auth/login")
    .send({ phone: "+7 (999) 123-45-67", password: "secret123" });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_CREDENTIALS",
      message: "Неверный номер телефона или пароль",
    },
  });
  assert.equal(cleanupCalls, 1);
  assert.equal(findTrustedCalls, 0);
  assert.equal(
    response.headers["set-cookie"]?.some((value: string) =>
      value.includes(`${env.authRefreshCookieName}=`),
    ),
    true,
  );
});

test("POST /auth/login accepts phone sent in email field and authorizes without device challenge when trusted-device flow is disabled", async () => {
  env.authTrustedDeviceEnforced = false;
  let issueTokensCalls = 0;
  let loginCalls = 0;
  (deviceTrustService.cleanupExpired as any) = async () => {};
  (deviceTrustService.findTrustedDeviceForRequest as any) = async () => {
    throw new Error("trusted device lookup should not run");
  };
  (authService.login as any) = async ({ phone }: { phone: string }) => {
    loginCalls += 1;
    assert.equal(phone, "+79991234567");
    return { user: baseUser };
  };
  (authService.issueTokens as any) = async () => {
    issueTokensCalls += 1;
    return {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      refreshExpiresAt: new Date(),
    };
  };

  const response = await request(buildApp())
    .post("/auth/login")
    .send({ email: "+7 (999) 123-45-67", password: "secret123" });

  assert.equal(response.status, 200);
  assert.equal(loginCalls, 1);
  assert.equal(issueTokensCalls, 1);
  assert.equal(response.body.data.accessToken, "access-token");
  assert.equal(response.body.data.session.trustedDevice, false);
});

test("POST /auth/login starts existing OTP flow for a new device and returns challenge contract without issuing session tokens", async () => {
  env.authTrustedDeviceEnforced = true;
  let trustedLookupCalls = 0;
  let otpRequests = 0;
  (deviceTrustService.cleanupExpired as unknown as () => Promise<void>) =
    async () => {};
  (deviceTrustService.findTrustedDeviceForRequest as unknown as () => Promise<null>) =
    async () => {
      trustedLookupCalls += 1;
      return null;
    };
  (authService.login as unknown as (
    args: { phone: string },
    password: string,
  ) => Promise<{ user: typeof baseUser }>) = async ({
    phone,
  }: {
    phone: string;
  }) => {
    assert.equal(phone, "+79991234567");
    return { user: baseUser };
  };
  (authService.issueTokens as unknown as () => Promise<never>) = async () => {
    throw new Error("issueTokens should not run for a new device challenge");
  };
  (otpService.requestOtp as unknown as (payload: {
    phone: string;
    purpose: string;
  }) => Promise<{
    ok: true;
    data: {
      requestId: string;
      phone: string;
      provider: "plusofon";
      verificationType: "call_to_auth";
      callToAuthNumber: string | null;
    };
  }>) = async (payload) => {
    otpRequests += 1;
    assert.equal(payload.phone, "+79991234567");
    assert.equal(payload.purpose, "login_device");
    return {
      ok: true,
      data: {
        requestId: "req-123",
        phone: "+79991234567",
        provider: "plusofon",
        verificationType: "call_to_auth",
        callToAuthNumber: "+78005553535",
      },
    };
  };

  const response = await request(buildApp())
    .post("/auth/login")
    .send({ phone: "+7 (999) 123-45-67", password: "secret123" });

  assert.equal(response.status, 403);
  assert.equal(trustedLookupCalls, 1);
  assert.equal(otpRequests, 1);
  assert.equal(response.body.error.code, "DEVICE_VERIFICATION_REQUIRED");
  assert.equal(response.body.requiresDeviceVerification, true);
  assert.equal(response.body.verificationMethod, "existing_otp_flow");
  assert.equal(response.body.requestId, "req-123");
  assert.equal(response.body.phone, "+79991234567");
  assert.equal(
    response.headers["set-cookie"]?.some((value: string) =>
      value.includes(`${env.authRefreshCookieName}=`),
    ),
    true,
  );
});

test("POST /auth/otp/verify completes login_device challenge via existing OTP endpoint and trusts device", async () => {
  const tempToken = authService.issueLoginDeviceOtpToken({ id: baseUser.id });
  let trustCalls = 0;
  let issueTokensCalls = 0;
  (otpService.verifyOtpByRequestId as unknown as (payload: {
    phone: string;
    requestId: string;
    purpose: string;
  }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, "+7 (999) 123-45-67");
    assert.equal(payload.requestId, "req-verified");
    assert.equal(payload.purpose, "login_device");
    return { phone: "+79991234567" };
  };
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (deviceTrustService.trustCurrentDevice as unknown as (
    userId: string,
  ) => Promise<{ device: { id: string }; token: string }>) = async (userId) => {
    trustCalls += 1;
    assert.equal(userId, baseUser.id);
    return { device: { id: "trusted-1" }, token: "trusted-token" };
  };
  (authService.issueTokens as unknown as () => Promise<{
    accessToken: string;
    refreshToken: string;
    refreshExpiresAt: Date;
  }>) = async () => {
    issueTokensCalls += 1;
    return {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      refreshExpiresAt: new Date(),
    };
  };

  const response = await request(buildApp())
    .post("/auth/otp/verify")
    .set("Authorization", `Bearer ${tempToken}`)
    .send({
      phone: "+7 (999) 123-45-67",
      requestId: "req-verified",
      purpose: "login_device",
    });

  assert.equal(response.status, 200);
  assert.equal(trustCalls, 1);
  assert.equal(issueTokensCalls, 1);
  assert.equal(response.body.data.accessToken, "access-token");
  assert.equal(response.body.data.session.trustedDevice, true);
  assert.equal(
    response.headers["set-cookie"]?.some((value: string) =>
      value.includes(`${env.trustedDeviceCookieName}=trusted-token`),
    ),
    true,
  );
});

test("POST /auth/otp/verify rejects purpose mismatch when tempToken scope is for device login", async () => {
  const tempToken = authService.issueLoginDeviceOtpToken({ id: baseUser.id });

  const response = await request(buildApp()).post("/auth/otp/verify").send({
    phone: "+7 (999) 123-45-67",
    requestId: "req-mismatch",
    purpose: "buyer_sensitive_action",
    tempToken,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "OTP_SCOPE_MISMATCH");
  assert.equal(response.body.expectedPurpose, "login_device");
});
test("POST /auth/login/device/verify accepts tempToken from body and completes device verification without explicit purpose", async () => {
  const tempToken = authService.issueLoginDeviceOtpToken({ id: baseUser.id });
  let trustCalls = 0;
  (otpService.verifyOtpByRequestId as unknown as (payload: {
    phone: string;
    requestId: string;
    purpose: string;
  }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, "+7 (999) 123-45-67");
    assert.equal(payload.requestId, "req-device-body");
    assert.equal(payload.purpose, "login_device");
    return { phone: "+79991234567" };
  };
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (deviceTrustService.trustCurrentDevice as unknown as (
    userId: string,
  ) => Promise<{ device: { id: string }; token: string }>) = async (userId) => {
    trustCalls += 1;
    assert.equal(userId, baseUser.id);
    return { device: { id: "trusted-2" }, token: "trusted-token-2" };
  };
  (authService.issueTokens as unknown as () => Promise<{
    accessToken: string;
    refreshToken: string;
    refreshExpiresAt: Date;
  }>) = async () => {
    return {
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2",
      refreshExpiresAt: new Date(),
    };
  };

  const response = await request(buildApp())
    .post("/auth/login/device/verify")
    .send({
      phone: "+7 (999) 123-45-67",
      requestId: "req-device-body",
      tempToken,
    });

  assert.equal(response.status, 200);
  assert.equal(trustCalls, 1);
  assert.equal(response.body.data.accessToken, "access-token-2");
  assert.equal(response.body.data.session.trustedDevice, true);
  assert.equal(
    response.headers["set-cookie"]?.some((value: string) =>
      value.includes(`${env.trustedDeviceCookieName}=trusted-token-2`),
    ),
    true,
  );
});

test("POST /auth/login/device/verify does not require phone when requestId + tempToken identify the challenge", async () => {
  const tempToken = authService.issueLoginDeviceOtpToken({ id: baseUser.id });
  let trustCalls = 0;
  (otpService.verifyOtpByRequestId as unknown as (payload: {
    phone?: string;
    requestId: string;
    purpose: string;
  }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, undefined);
    assert.equal(payload.requestId, "req-device-no-phone");
    assert.equal(payload.purpose, "login_device");
    return { phone: "+79991234567" };
  };
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (deviceTrustService.trustCurrentDevice as unknown as (
    userId: string,
  ) => Promise<{ device: { id: string }; token: string }>) = async (userId) => {
    trustCalls += 1;
    assert.equal(userId, baseUser.id);
    return { device: { id: "trusted-3" }, token: "trusted-token-3" };
  };
  (authService.issueTokens as unknown as () => Promise<{
    accessToken: string;
    refreshToken: string;
    refreshExpiresAt: Date;
  }>) = async () => ({
    accessToken: "access-token-3",
    refreshToken: "refresh-token-3",
    refreshExpiresAt: new Date(),
  });

  const response = await request(buildApp())
    .post("/auth/login/device/verify")
    .send({
      requestId: "req-device-no-phone",
      tempToken,
    });

  assert.equal(response.status, 200);
  assert.equal(trustCalls, 1);
  assert.equal(response.body.data.accessToken, "access-token-3");
});

test("POST /auth/password-reset/request starts the existing OTP flow and returns reusable challenge contract", async () => {
  let otpRequests = 0;
  (userRepository.findByPhone as unknown as (
    phone: string,
  ) => Promise<typeof baseUser | null>) = async (phone) => {
    assert.equal(phone, "+79991234567");
    return baseUser;
  };
  (otpService.requestOtp as unknown as (payload: {
    phone: string;
    purpose: string;
  }) => Promise<{
    ok: true;
    data: {
      requestId: string;
      phone: string;
      provider: "plusofon";
      verificationType: "call_to_auth";
      callToAuthNumber: string | null;
    };
  }>) = async (payload) => {
    otpRequests += 1;
    assert.equal(payload.phone, "+79991234567");
    assert.equal(payload.purpose, "password_reset");
    return {
      ok: true,
      data: {
        requestId: "reset-req-1",
        phone: "+79991234567",
        provider: "plusofon",
        verificationType: "call_to_auth",
        callToAuthNumber: "+78005553535",
      },
    };
  };

  const response = await request(buildApp())
    .post("/auth/password-reset/request")
    .send({ phone: "+7 (999) 123-45-67" });

  assert.equal(response.status, 200);
  assert.equal(otpRequests, 1);
  assert.equal(response.body.verificationMethod, "existing_otp_flow");
  assert.equal(response.body.requestId, "reset-req-1");
  assert.equal(response.body.phone, "+79991234567");
  assert.equal(typeof response.body.tempToken, "string");
  assert.equal(response.body.requiresPasswordResetVerification, true);
});

test("POST /auth/password-reset/verify validates password reset via the existing OTP token flow", async () => {
  const tempToken = authService.issuePasswordResetOtpToken({ id: baseUser.id });
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (otpService.verifyOtpByRequestId as unknown as (payload: {
    phone: string;
    requestId: string;
    purpose: string;
  }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, "+7 (999) 123-45-67");
    assert.equal(payload.requestId, "reset-req-verified");
    assert.equal(payload.purpose, "password_reset");
    return { phone: "+79991234567" };
  };

  const response = await request(buildApp())
    .post("/auth/password-reset/verify")
    .set("Authorization", `Bearer ${tempToken}`)
    .send({ phone: "+7 (999) 123-45-67", requestId: "reset-req-verified" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.resetToken, "string");
});

test("POST /auth/password-reset/verify does not require phone when requestId + tempToken identify the challenge", async () => {
  const tempToken = authService.issuePasswordResetOtpToken({ id: baseUser.id });
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (otpService.verifyOtpByRequestId as unknown as (payload: {
    phone?: string;
    requestId: string;
    purpose: string;
  }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, undefined);
    assert.equal(payload.requestId, "reset-req-no-phone");
    assert.equal(payload.purpose, "password_reset");
    return { phone: "+79991234567" };
  };

  const response = await request(buildApp())
    .post("/auth/password-reset/verify")
    .set("Authorization", `Bearer ${tempToken}`)
    .send({ requestId: "reset-req-no-phone" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.resetToken, "string");
});

test("POST /auth/otp/verify infers password_reset purpose from tempToken when purpose is omitted", async () => {
  const tempToken = authService.issuePasswordResetOtpToken({ id: baseUser.id });
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (otpService.verifyOtpByRequestId as unknown as (payload: {
    phone: string;
    requestId: string;
    purpose: string;
  }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, "+7 (999) 123-45-67");
    assert.equal(payload.requestId, "reset-req-generic");
    assert.equal(payload.purpose, "password_reset");
    return { phone: "+79991234567" };
  };

  const response = await request(buildApp()).post("/auth/otp/verify").send({
    phone: "+7 (999) 123-45-67",
    requestId: "reset-req-generic",
    tempToken,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.resetToken, "string");
});

test("POST /auth/password-reset/resend returns updated lifecycle metadata and 429 while challenge is throttled", async () => {
  const tempToken = authService.issuePasswordResetOtpToken({ id: baseUser.id });
  (userRepository.findById as unknown as (
    id: string,
  ) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (otpService.requestOtp as unknown as (payload: {
    phone: string;
    purpose: string;
  }) => Promise<{ ok: true; throttled: true }>) = async (payload) => {
    assert.equal(payload.phone, "+7 (999) 123-45-67");
    assert.equal(payload.purpose, "password_reset");
    return { ok: true, throttled: true };
  };

  const response = await request(buildApp())
    .post("/auth/password-reset/resend")
    .set("Authorization", `Bearer ${tempToken}`)
    .send({ phone: "+7 (999) 123-45-67" });

  assert.equal(response.status, 429);
  assert.equal(
    response.body.error.code,
    "PASSWORD_RESET_VERIFICATION_REQUIRED",
  );
  assert.equal(response.body.otpThrottled, true);
  assert.equal(typeof response.body.retryAfterSeconds, "number");
  assert.equal(typeof response.body.resendAvailableAt, "string");
  assert.equal(response.body.currentActiveRequestId, null);
});

test("POST /auth/refresh rotates refresh token and returns access token in both legacy and new fields", async () => {
  const app = buildApp();
  const refreshToken = "refresh-token-1";
  (authService.refresh as unknown as (
    token: string,
  ) => Promise<{ accessToken: string; refreshToken: string }>) = async (
    token,
  ) => {
    assert.equal(token, refreshToken);
    return {
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2",
    };
  };

  const response = await request(app)
    .post("/auth/refresh")
    .set("Cookie", `${env.authRefreshCookieName}=${refreshToken}`)
    .send({});

  assert.equal(response.status, 200);
  assert.equal(response.body.token, "access-token-2");
  assert.equal(response.body.accessToken, "access-token-2");
  assert.equal(response.body.refreshTokenRotated, true);
  assert.equal(
    response.body.accessTokenTtlMinutes,
    env.authAccessTokenTtlMinutes,
  );
  assert.equal(response.body.refreshTokenTtlDays, env.authRefreshTokenTtlDays);
  assert.equal(
    response.headers["set-cookie"]?.some((value: string) =>
      value.includes(`${env.authRefreshCookieName}=refresh-token-2`),
    ),
    true,
  );
});
