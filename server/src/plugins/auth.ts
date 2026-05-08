import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { authEnv } from "../config/authEnv.js";
import type {
  AccessTokenPayload,
  AuthenticatedUser,
} from "../services/auth.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AuthenticatedUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken: (payload: AccessTokenPayload) => string;
  }
}

const authPlugin = fp(
  async (app: FastifyInstance) => {
    await app.register(cookie);
    await app.register(jwt, {
      secret: authEnv.jwtSecret,
      sign: {
        algorithm: "HS256",
        expiresIn: authEnv.accessTokenTtl,
      },
    });

    app.decorate("signAccessToken", (payload: AccessTokenPayload) =>
      app.jwt.sign(payload),
    );
  },
  { name: "auth" },
);

export default authPlugin;
