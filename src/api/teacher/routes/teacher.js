"use strict";

module.exports = {
  routes: [
    // ADMIN ROUTES
    {
      method: "POST",
      path: "/teachers",
      handler: "teacher.create",
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/teachers/resend-setup-email",
      handler: "teacher.resendSetupEmail",
      config: {
        policies: [],
        middlewares: [],
      },
    },

    // PUBLIC ROUTES
    {
      method: "POST",
      path: "/teachers/set-password",
      handler: "teacher.setPassword",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/teachers/login",
      handler: "teacher.login",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/teachers/forgot-password",
      handler: "teacher.forgotPassword",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "GET",
      path: "/teachers/me",
      handler: "teacher.me",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};