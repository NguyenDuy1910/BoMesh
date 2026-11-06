export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PasswordRule {
  test: (password: string) => boolean;
  label: string;
  required: boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { test: (pw) => pw.length >= 8, label: "At least 8 characters", required: true },
  { test: (pw) => /[A-Za-z]/.test(pw) && /\d/.test(pw), label: "Letters and numbers", required: true },
  {
    test: (pw) => pw.length >= 12 || /[^A-Za-z0-9]/.test(pw),
    label: "A symbol or 12+ characters for extra strength",
    required: false,
  },
];

export type StrengthTone = "danger" | "warning" | "success";

export interface PasswordStrength {
  tone: StrengthTone;
  label: "Weak" | "Fair" | "Good" | "Strong";
  value: number;
}

export function passwordStrength(pw: string): PasswordStrength | null {
  if (!pw) return null;
  const score =
    PASSWORD_RULES.filter((r) => r.test(pw)).length + (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw) ? 1 : 0);
  const levels: [StrengthTone, PasswordStrength["label"]][] = [
    ["danger", "Weak"],
    ["danger", "Weak"],
    ["warning", "Fair"],
    ["success", "Good"],
    ["success", "Strong"],
  ];
  const [tone, label] = levels[score];
  return { tone, label, value: score * 25 };
}

export function passwordAcceptable(pw: string): boolean {
  return PASSWORD_RULES.filter((r) => r.required).every((r) => r.test(pw));
}

export function validateIdentifier(identifier: string): string | undefined {
  const id = identifier.trim();
  if (!id) return "Enter your email or username.";
  if (id.includes("@") && !EMAIL_RE.test(id)) return "Enter a full email address, like name@company.com.";
  if (!id.includes("@") && id.length < 3) return "Usernames have at least 3 characters.";
  return undefined;
}
