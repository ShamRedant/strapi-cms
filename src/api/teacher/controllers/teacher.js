"use strict";

const { createCoreController } = require("@strapi/strapi").factories;
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

module.exports = createCoreController("api::teacher.teacher", ({ strapi }) => ({
  /**
   * ADMIN: Create teacher (token auto-generated in lifecycle)
   * Admin only provides: name, email, username, phone, qualification
   */
  async create(ctx) {
    const { name, email, username, phone, qualification } = ctx.request.body;

    // Validate required fields
    if (!email || !username || !name) {
      return ctx.badRequest("Email, username, and name are required");
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return ctx.badRequest("Invalid email format");
    }

    try {
      // Check if email already exists
      const existingEmail = await strapi.entityService.findMany("api::teacher.teacher", {
        filters: { email },
      });

      if (existingEmail && existingEmail.length > 0) {
        return ctx.badRequest("A teacher with this email already exists");
      }

      // Check if username is taken
      const existingUsername = await strapi.entityService.findMany("api::teacher.teacher", {
        filters: { username },
      });

      if (existingUsername && existingUsername.length > 0) {
        return ctx.badRequest("This username is already taken");
      }

      // Create teacher - token and expiry auto-generated in lifecycle hook
      const teacher = await strapi.entityService.create("api::teacher.teacher", {
        data: {
          name,
          email,
          username,
          phone: phone || null,
          qualification: qualification || null,
        },
      });

      console.log(`✅ Teacher created: ${email} (ID: ${teacher.id})`);

      return ctx.send({
        message: "Teacher account created successfully. Password setup email has been sent (expires in 1 hour).",
        data: {
          id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          username: teacher.username,
          phone: teacher.phone,
          qualification: teacher.qualification,
          isActive: false,
        },
      });

    } catch (error) {
      console.error("❌ Error creating teacher:", error);
      return ctx.internalServerError("Failed to create teacher account. Please try again.");
    }
  },

  /**
   * ADMIN: Resend password setup email (regenerates token with 1 hour expiry)
   */
  async resendSetupEmail(ctx) {
    const { teacherId } = ctx.request.body;

    if (!teacherId) {
      return ctx.badRequest("Teacher ID is required");
    }

    try {
      const teacher = await strapi.entityService.findOne("api::teacher.teacher", teacherId);

      if (!teacher) {
        return ctx.notFound("Teacher not found");
      }

      // Generate new token with 1 hour expiry
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Update teacher with new token
      await strapi.entityService.update("api::teacher.teacher", teacherId, {
        data: {
          resetPasswordToken: resetTokenHash,
          resetPasswordExpires: resetExpires,
        },
      });

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      const setupUrl = `${frontendUrl}/set-password?token=${resetToken}`;

      await strapi.plugins["email"].services.email.send({
        to: teacher.email,
        from: process.env.EMAIL_FROM || "noreply@yourapp.com",
        subject: teacher.isActive ? "Password Reset Request" : "⏰ Reminder: Set Up Your Password (1 Hour)",
        html: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
              <div style="background-color: white; padding: 30px; border-radius: 8px;">
                <h2 style="color: #4F46E5;">${teacher.isActive ? '🔐 Password Reset' : '⏰ Password Setup Reminder'}</h2>
                <p>Hi <strong>${teacher.name}</strong>,</p>
                <p>${teacher.isActive 
                  ? 'You requested to reset your password.' 
                  : 'This is a reminder to set up your password and activate your account.'
                }</p>
                <p><strong>Username:</strong> ${teacher.username}</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${setupUrl}" style="display: inline-block; padding: 14px 28px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">
                    ${teacher.isActive ? 'Reset Password' : 'Set Up Password'}
                  </a>
                </div>
                <p>Or copy this link:</p>
                <div style="background-color: #f5f5f5; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 13px;">${setupUrl}</div>
                <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; border-radius: 4px; margin: 15px 0;">
                  <strong>⏰ URGENT:</strong> This link will expire in <strong>1 HOUR</strong>!
                </div>
              </div>
            </div>
          </body>
          </html>
        `,
      });

      console.log(`✅ Setup email resent to ${teacher.email} (expires in 1 hour)`);

      return ctx.send({
        message: "Password setup email sent successfully (expires in 1 hour)",
      });

    } catch (error) {
      console.error("❌ Error resending setup email:", error);
      return ctx.internalServerError("Failed to send email");
    }
  },

  /**
   * PUBLIC: Set password (first time - activates account)
   */
  async setPassword(ctx) {
    const { token, password, passwordConfirmation } = ctx.request.body;

    if (!token || !password || !passwordConfirmation) {
      return ctx.badRequest("Token, password, and password confirmation are required");
    }

    if (password !== passwordConfirmation) {
      return ctx.badRequest("Passwords do not match");
    }

    if (password.length < 8) {
      return ctx.badRequest("Password must be at least 8 characters long");
    }

    try {
      // Hash the token to match stored hash
      const resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");

      // Find teacher with matching token
    const teachers = await strapi.db.query("api::teacher.teacher").findMany({
  where: { resetPasswordToken: resetTokenHash },
});


      if (!teachers || teachers.length === 0) {
        return ctx.badRequest("Invalid or expired setup link");
      }

      const teacher = teachers[0];

      if (teacher.resetPasswordExpires && new Date(teacher.resetPasswordExpires) < new Date()) {
        return ctx.badRequest("Setup link has expired (valid for 1 hour only). Please contact your administrator for a new link.");
      }
      const hashedPassword = await bcrypt.hash(password, 10);

      await strapi.entityService.update("api::teacher.teacher", teacher.id, {
        data: {
          password: hashedPassword,
          isActive: true,
          passwordSetAt: new Date(),
          resetPasswordToken: null,
          resetPasswordExpires: null,
        },
      });
      console.log(`✅ Password set and account activated for: ${teacher.email}`);
      return ctx.send({
        message: "Password set successfully! Your account is now active. You can log in now.",
        success: true,
      });

    } catch (error) {
      console.error("❌ Error setting password:", error);
      return ctx.internalServerError("Failed to set password. Please try again.");
    }
  },

  /**
   * PUBLIC: Teacher login
   */
 async login(ctx) {
  const { identifier, password } = ctx.request.body;

  if (!identifier || !password) {
    return ctx.badRequest("Email/username and password are required");
  }

  try {
    const teachers = await strapi.db.query("api::teacher.teacher").findMany({
      where: {
        $or: [{ email: identifier }, { username: identifier }],
      },
      select: [
        "id",
        "name",
        "email",
        "username",
        "password",
        "phone",
        "qualification",
        "isActive",
      ],
    });

    if (!teachers || teachers.length === 0) {
      return ctx.badRequest("Invalid credentials");
    }

    const teacher = teachers[0];

    if (!teacher.isActive) {
      return ctx.badRequest("Account is not activated. Please check your email.");
    }

    const isPasswordValid = await bcrypt.compare(password, teacher.password);

    if (!isPasswordValid) {
      return ctx.badRequest("Invalid credentials");
    }

    const jwtToken = jwt.sign(
      {
        id: teacher.id,
        email: teacher.email,
        username: teacher.username,
        name: teacher.name,
        type: "teacher",
      },
      process.env.JWT_SECRET || "default-secret-key",
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    return ctx.send({
      message: "Login successful",
      data: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        username: teacher.username,
        phone: teacher.phone,
        qualification: teacher.qualification,
      },
      token: jwtToken,
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    return ctx.internalServerError("Login failed. Please try again.");
  }
},


  /**
   * PUBLIC: Forgot password (for active accounts, 1 hour expiry)
   */
  async forgotPassword(ctx) {
    const { email } = ctx.request.body;

    if (!email) {
      return ctx.badRequest("Email is required");
    }

    try {
      const teachers = await strapi.entityService.findMany("api::teacher.teacher", {
        filters: { email },
      });

      if (!teachers || teachers.length === 0) {
        return ctx.send({
          message: "If an account exists with this email, a password reset link has been sent.",
        });
      }

      const teacher = teachers[0];

      if (!teacher.isActive) {
        return ctx.send({
          message: "If an account exists with this email, a password reset link has been sent.",
        });
      }

      // Generate reset token with 1 hour expiry
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await strapi.entityService.update("api::teacher.teacher", teacher.id, {
        data: {
          resetPasswordToken: resetTokenHash,
          resetPasswordExpires: resetExpires,
        },
      });

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

      await strapi.plugins["email"].services.email.send({
        to: email,
        from: process.env.EMAIL_FROM || "noreply@yourapp.com",
        subject: "Password Reset Request (1 Hour)",
        html: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
              <div style="background-color: white; padding: 30px; border-radius: 8px;">
                <h2 style="color: #4F46E5;">🔐 Password Reset Request</h2>
                <p>Hi <strong>${teacher.name}</strong>,</p>
                <p>We received a request to reset your password.</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${resetUrl}" style="display: inline-block; padding: 14px 28px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
                </div>
                <p>Or copy this link:</p>
                <div style="background-color: #f5f5f5; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 13px;">${resetUrl}</div>
                <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; border-radius: 4px; margin: 15px 0;">
                  <strong>⏰ This link will expire in 1 HOUR.</strong>
                </div>
                <p style="color: #666; font-size: 13px; margin-top: 20px;">
                  If you didn't request this reset, please ignore this email.
                </p>
              </div>
            </div>
          </body>
          </html>
        `,
      });

      console.log(`✅ Password reset email sent to ${email} (expires in 1 hour)`);

      return ctx.send({
        message: "If an account exists with this email, a password reset link has been sent.",
      });

    } catch (error) {
      console.error("❌ Error in forgot password:", error);
      return ctx.internalServerError("Failed to process request");
    }
  },

  /**
   * PUBLIC: Get teacher profile
   */
  async me(ctx) {
    try {
      const authHeader = ctx.request.headers.authorization;

      if (!authHeader) {
        return ctx.unauthorized("No authorization token provided");
      }

      const token = authHeader.replace("Bearer ", "");
      const decoded = jwt.verify(token, process.env.JWT_SECRET || "default-secret-key");

      const teacher = await strapi.entityService.findOne("api::teacher.teacher", decoded.id);

      if (!teacher) {
        return ctx.notFound("Teacher not found");
      }

      if (!teacher.isActive) {
        return ctx.unauthorized("Account is not active");
      }

      return ctx.send({
        data: {
          id: teacher.id,
          name: teacher.name,
          email: teacher.email,
          username: teacher.username,
          phone: teacher.phone,
          qualification: teacher.qualification,
          isActive: teacher.isActive,
          passwordSetAt: teacher.passwordSetAt,
        },
      });

    } catch (error) {
      console.error("❌ Error fetching profile:", error);
      return ctx.unauthorized("Invalid or expired token");
    }
  },
}));