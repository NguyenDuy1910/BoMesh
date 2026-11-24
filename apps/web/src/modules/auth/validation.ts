export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PasswordRule {
  test: (password: string) => boolean;
  label: string;
  required: boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { test: (pw) => pw.length >= 8, label: "Ít nhất 8 ký tự", required: true },
  { test: (pw) => /[A-Za-z]/.test(pw) && /\d/.test(pw), label: "Chữ và số", required: true },
  {
    test: (pw) => pw.length >= 12 || /[^A-Za-z0-9]/.test(pw),
    label: "Thêm ký hiệu hoặc từ 12 ký tự để mạnh hơn",
    required: false,
  },
];

export type StrengthTone = "danger" | "warning" | "success";

export interface PasswordStrength {
  tone: StrengthTone;
  label: "Yếu" | "Trung bình" | "Tốt" | "Mạnh";
  value: number;
}

export function passwordStrength(pw: string): PasswordStrength | null {
  if (!pw) return null;
  const score =
    PASSWORD_RULES.filter((r) => r.test(pw)).length + (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw) ? 1 : 0);
  const levels: [StrengthTone, PasswordStrength["label"]][] = [
    ["danger", "Yếu"],
    ["danger", "Yếu"],
    ["warning", "Trung bình"],
    ["success", "Tốt"],
    ["success", "Mạnh"],
  ];
  const [tone, label] = levels[score];
  return { tone, label, value: score * 25 };
}

export function passwordAcceptable(pw: string): boolean {
  return PASSWORD_RULES.filter((r) => r.required).every((r) => r.test(pw));
}

export function validateIdentifier(identifier: string): string | undefined {
  const id = identifier.trim();
  if (!id) return "Nhập email hoặc tên người dùng.";
  if (id.includes("@") && !EMAIL_RE.test(id)) return "Nhập địa chỉ email đầy đủ, ví dụ name@company.com.";
  if (!id.includes("@") && id.length < 3) return "Tên người dùng có ít nhất 3 ký tự.";
  return undefined;
}
