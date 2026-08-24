import nodemailer from "nodemailer";

export interface MagicLinkMessage {
  readonly recipient: string;
  readonly magicLink: string;
  readonly expiresInMinutes: number;
}

export interface MagicLinkEmailSender {
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
}

export interface SmtpEmailSenderOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

export class SmtpMagicLinkEmailSender implements MagicLinkEmailSender {
  private readonly transporter;

  public constructor(private readonly options: SmtpEmailSenderOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user
        ? {
            auth: {
              user: options.user,
              pass: options.password
            }
          }
        : {})
    });
  }

  public async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: message.recipient,
      subject: "Call Now ログインリンク",
      text: [
        "Call Nowへのログインがリクエストされました。",
        "",
        `以下のリンクは${message.expiresInMinutes}分間、1回だけ利用できます。`,
        message.magicLink,
        "",
        "心当たりがない場合は、このメールを破棄してください。"
      ].join("\n")
    });
  }
}
