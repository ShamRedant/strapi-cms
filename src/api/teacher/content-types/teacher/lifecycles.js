"use strict";

const crypto = require("crypto");

module.exports = {
  /**
   * Automatically generate reset token and expiry when teacher is created
   */
  async beforeCreate(event) {
    const { data } = event.params;

    // Auto-generate password reset token (hidden from admin)
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    
    // Set expiry to 1 hour from now
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Add hidden fields to the data
    data.resetPasswordToken = resetTokenHash;
    data.resetPasswordExpires = resetExpires;
    data.isActive = false; // Account inactive until password is set

    console.log(`🔐 Auto-generated reset token for new teacher (expires in 1 hour)`);

    // Store the plain token temporarily so we can send it in email
    // We'll use it in afterCreate
    event.params._plainResetToken = resetToken;
  },

  /**
   * Send email after teacher is created
   */
  async afterCreate(event) {
    const { result, params } = event;
    const plainResetToken = params._plainResetToken;

    if (!plainResetToken) {
      console.error("❌ Reset token not found in params");
      return;
    }

    try {
      // Check if email plugin is configured
      if (!strapi.plugins['email']) {
        console.error("❌ Email plugin is not configured");
        return;
      }

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      const setupUrl = `${frontendUrl}/set-password?token=${plainResetToken}`;

      await strapi.plugins["email"].services.email.send({
        to: result.email,
        from: process.env.EMAIL_FROM || "noreply@yourapp.com",
        subject: "🎉 Welcome! Set Up Your Teacher Account Password",
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                line-height: 1.6; 
                color: #333; 
                margin: 0;
                padding: 0;
              }
              .email-container { 
                max-width: 600px; 
                margin: 0 auto; 
                padding: 20px; 
                background-color: #f4f7fa; 
              }
              .email-content { 
                background-color: white; 
                padding: 40px 30px; 
                border-radius: 10px; 
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              }
              .header { 
                text-align: center; 
                margin-bottom: 30px; 
              }
              .header h1 { 
                color: #4F46E5; 
                margin: 0;
                font-size: 28px;
              }
              .welcome-badge {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 15px;
                border-radius: 8px;
                text-align: center;
                margin: 20px 0;
              }
              .info-box { 
                background-color: #f8f9fa; 
                padding: 20px; 
                border-radius: 8px; 
                margin: 20px 0;
                border-left: 4px solid #4F46E5;
              }
              .info-box p {
                margin: 8px 0;
              }
              .info-box strong {
                color: #4F46E5;
                min-width: 100px;
                display: inline-block;
              }
              .button-container {
                text-align: center; 
                margin: 35px 0;
              }
              .button { 
                display: inline-block; 
                padding: 16px 32px; 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white !important; 
                text-decoration: none; 
                border-radius: 8px; 
                font-weight: bold;
                font-size: 16px;
                box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
              }
              .link-box { 
                background-color: #f5f5f5; 
                padding: 15px; 
                border-radius: 6px; 
                word-break: break-all;
                font-size: 13px;
                margin: 15px 0;
                border: 1px dashed #ddd;
              }
              .footer { 
                color: #666; 
                font-size: 13px; 
                margin-top: 30px; 
                padding-top: 20px;
                border-top: 2px solid #f0f0f0;
                text-align: center;
              }
              .urgent {
                background-color: #fff3cd;
                border-left: 4px solid #ffc107;
                padding: 12px;
                border-radius: 4px;
                margin: 15px 0;
              }
              .steps {
                background-color: #e7f3ff;
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
              }
              .steps ol {
                margin: 10px 0;
                padding-left: 20px;
              }
              .steps li {
                margin: 8px 0;
              }
            </style>
          </head>
          <body>
            <div class="email-container">
              <div class="email-content">
                <div class="header">
                  <h1>🎓 Welcome to Our Platform!</h1>
                </div>
                
                <div class="welcome-badge">
                  <h2 style="margin: 0; font-size: 20px;">Hello, ${result.name}! 👋</h2>
                  <p style="margin: 5px 0 0 0; opacity: 0.9;">Your teacher account has been created successfully</p>
                </div>

                <p style="font-size: 16px; margin: 20px 0;">We're excited to have you on board! Your account has been set up by our administrator.</p>

                <div class="info-box">
                  <p><strong>📧 Email:</strong> ${result.email}</p>
                  <p><strong>👤 Username:</strong> ${result.username}</p>
                  ${result.phone ? `<p><strong>📱 Phone:</strong> ${result.phone}</p>` : ''}
                </div>

                <div class="steps">
                  <h3 style="margin-top: 0; color: #4F46E5;">📋 Next Steps:</h3>
                  <ol>
                    <li><strong>Click the button below</strong> to set your password</li>
                    <li><strong>Create a strong password</strong> (minimum 8 characters)</li>
                    <li><strong>Your account will be activated</strong> automatically</li>
                    <li><strong>Log in</strong> with your username/email and new password</li>
                  </ol>
                </div>

                <div class="button-container">
                  <a href="${setupUrl}" class="button">🔐 Set Up My Password</a>
                </div>

                <p style="text-align: center; color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
                <div class="link-box">${setupUrl}</div>

                <div class="urgent">
                  <strong>⏰ URGENT:</strong> This link will expire in <strong>1 HOUR</strong>. Please set your password immediately!
                </div>

                <div class="footer">
                  <p><strong>Need help?</strong> Contact your administrator if you have any questions.</p>
                  <p style="margin: 5px 0;">This is an automated message, please do not reply to this email.</p>
                </div>
              </div>
            </div>
          </body>
          </html>
        `,
      });

      console.log(`✅ Password setup email sent successfully to ${result.email} (expires in 1 hour)`);

    } catch (emailError) {
      console.error("❌ Failed to send password setup email:", emailError);
      console.error("Email error details:", {
        message: emailError.message,
        code: emailError.code,
      });
    }
  },
};