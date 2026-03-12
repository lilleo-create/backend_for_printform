import crypto from 'crypto';
import { env } from '../config/env';

export const generateOtpCode = () => {
  const value = crypto.randomInt(0, 1_000_000);
  return value.toString().padStart(6, '0');
};

export const hashOtpCode = (code: string) =>
  crypto.createHash('sha256').update(`${code}${env.otpPepper}`).digest('hex');
