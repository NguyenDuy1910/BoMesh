/** Home read model (`GetMemberHome`, api_design.md §9 "Home"): starters, picks, domains, getting started. */

import { api, call, type Schema } from "@/lib/api/client";

export type MemberHome = Schema<"MemberHome">;
export type MemberHomeItem = Schema<"MemberHomeItem">;
export type MemberHomeRecommended = Schema<"MemberHomeRecommendedItem">;
export type MemberHomeDomain = Schema<"MemberHomeTopicDomain">;
export type StarterPrompt = NonNullable<MemberHome["starterPrompts"]>[number];

export const homeKeys = {
  home: (ws: string) => [ws, "memberHome"] as const,
};

export function getMemberHome(workspace: string): Promise<MemberHome> {
  return call(api.GET("/api/v1/workspaces/{workspace}/members/{member}/home", { params: { path: { workspace, member: "me" } } }));
}
