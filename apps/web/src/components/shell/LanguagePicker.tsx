"use client";

import { Description, Label, ListBox, Select } from "@heroui/react";
import { ChevronsUpDown, Globe } from "lucide-react";

import { toast } from "@/components/ui/Toast";
import { getLanguage, LANGUAGES, setLanguage, useLanguage, type Language } from "@/lib/i18n";

/**
 * Switch the interface language with an Undo toast (preview `X.lang.change`).
 * The toast is written in English; the active dictionary localizes it like any other copy.
 */
export function changeLanguage(code: Language): void {
  const before = getLanguage();
  if (code === before) return;
  void setLanguage(code).then(() => {
    toast(code === "vi" ? "Language changed to Tiếng Việt" : "Language changed to English", {
      tone: "accent",
      undo: () => void setLanguage(before),
    });
  });
}

/** Compact picker for pages without the shell (sign-in, sign-up, workspace choice). */
export function LanguagePicker() {
  const [language] = useLanguage();
  return (
    <span className="lang-picker">
      <Globe className="i i-sm" aria-hidden />
      <Select
        aria-label="Language"
        value={language}
        onChange={(key) => key && changeLanguage(key as Language)}
        className="select--sm"
      >
        <Select.Trigger>
          <Select.Value translate="no" />
          <Select.Indicator>
            <ChevronsUpDown aria-hidden />
          </Select.Indicator>
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {LANGUAGES.map((l) => (
              <ListBox.Item key={l.code} id={l.code} textValue={l.native}>
                <span translate="no">{l.native}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </span>
  );
}

/** Preferences field: applies at once, like Appearance. */
export function LanguageField() {
  const [language] = useLanguage();
  return (
    <Select fullWidth value={language} onChange={(key) => key && changeLanguage(key as Language)}>
      <Label>Language</Label>
      <Select.Trigger>
        <Select.Value translate="no" />
        <Select.Indicator />
      </Select.Trigger>
      <Description>
        Menus, buttons and messages. Documents, answers and workspace names stay in the language they were written in.
      </Description>
      <Select.Popover>
        <ListBox>
          {LANGUAGES.map((l) => {
            const label = l.native === l.english ? l.native : `${l.native} — ${l.english}`;
            return (
              <ListBox.Item key={l.code} id={l.code} textValue={label}>
                <span translate="no">{label}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            );
          })}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
