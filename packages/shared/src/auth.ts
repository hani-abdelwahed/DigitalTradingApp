import { z } from 'zod';

// Request and response contracts shared by the API and the web app.

export const emailSchema = z.email().max(254).transform((v) => v.trim().toLowerCase());

// NIST SP 800-63B: favour length over composition rules.
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const registerRequest = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const loginRequest = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const mfaVerifyRequest = z.object({
  mfaToken: z.string().min(1),
  code: totpCodeSchema,
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequest>;

export const mfaEnableRequest = z.object({ code: totpCodeSchema });
export type MfaEnableRequest = z.infer<typeof mfaEnableRequest>;

export const mfaDisableRequest = z.object({
  code: totpCodeSchema,
  password: z.string().min(1).max(128),
});
export type MfaDisableRequest = z.infer<typeof mfaDisableRequest>;

export interface PublicUser {
  id: string;
  email: string;
  mfaEnabled: boolean;
  createdAt: string;
}

export type LoginResponse =
  | { status: 'ok'; accessToken: string; expiresIn: number; user: PublicUser }
  | { status: 'mfa_required'; mfaToken: string };

export interface TokenResponse {
  status: 'ok';
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
}

export interface MfaSetupResponse {
  otpauthUrl: string;
  secret: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
