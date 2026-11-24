"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Callout } from "@/components/ui/Callout";
import { getSession, sessionTransition, useSession, useSessionExpired, type StoredSession } from "@/lib/session";
import { routeAfterSignIn } from "@/modules/auth/api";
import { isLinkNext, safeNext } from "@/modules/auth/next";
import { AuthLayout, AuthLink } from "@/modules/auth/components/AuthLayout";
import { SignInForm } from "@/modules/auth/components/SignInForm";

export function SignInPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const next = params.get("next");
  // A link someone was sent (`/s/…`, `/w/…`): say so, and keep it when they choose Create account instead.
  const shareNext = isLinkNext(safeNext(next)) ? safeNext(next) : null;
  const session = useSession();
  const expired = useSessionExpired();
  // The person whose session expired; kept after their sign-in replaces it.
  const [previous, setPrevious] = useState<StoredSession | null>(null);
  if (expired && session && previous?.name !== session.name) setPrevious(session);

  // Already signed in: continue to the workspace instead of showing the form.
  useEffect(() => {
    if (!getSession()) return;
    routeAfterSignIn(queryClient, next).then((to) => router.replace(to), () => undefined);
  }, [next, router, queryClient]);

  async function signedIn(fresh: StoredSession) {
    // `next` is the expired person's page: anyone else starts from their own workspace.
    const back = !previous || sessionTransition(previous, fresh) === "renewed" ? next : null;
    router.replace(await routeAfterSignIn(queryClient, back));
  }

  return (
    <AuthLayout art>
      <h1 className="t-title au-title">Đăng nhập</h1>
      {params.get("reason") === "expired" ? (
        <div className="au-notice">
          <Callout tone="accent" icon={Clock} title="Phiên đăng nhập đã hết hạn" description="Đăng nhập lại để quay về trang bạn đang xem." />
        </div>
      ) : (
        <p className="muted au-sub">{shareNext ? "Đăng nhập để mở liên kết bạn được gửi." : "Chào mừng trở lại. Đăng nhập để tiếp tục vào không gian làm việc của bạn."}</p>
      )}
      <SignInForm
        key={previous?.name}
        initialId={previous ? previous.user.email || previous.user.username : (params.get("email") ?? undefined)}
        showForgot
        googleLast
        onSignedIn={signedIn}
      />
      <p className="au-foot">
        Mới dùng BoMesh? <AuthLink href={shareNext ? `/signup?next=${encodeURIComponent(shareNext)}` : "/signup"}>Tạo tài khoản</AuthLink>
      </p>
    </AuthLayout>
  );
}
