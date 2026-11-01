"use client";

import { BarChart3, ChevronDown, Copy, Globe, LayoutGrid, List, MoreHorizontal, Plus, Upload } from "lucide-react";
import { useState } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/Radio";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { Tooltip } from "@/components/ui/Tooltip";
import { ui } from "@/components/ui/design-system";

import { Grid, Group, Row, Section, Specimen } from "./kit";

/* Pointer and focus states cannot be triggered from markup, so these
   specimens apply the same token classes the primitive uses on :hover,
   :active and :focus-visible. Real hover and focus work on every other
   button on the page. */
const FORCED = {
  primaryHover: "bg-accent-hover",
  primaryPressed: "bg-accent-pressed",
  focus: "shadow-(--shadow-focus)",
  secondaryHover: "border-border-strong bg-surface-hover",
  ghostHover: "bg-surface-hover text-text-primary",
  dangerHover: "bg-danger-solid-hover",
  fieldFocus: "border-border-focus shadow-(--shadow-focus)",
} as const;

export function ButtonsSection() {
  return (
    <Section
      description="One primary per view. Secondary for alternatives. Ghost for tertiary and row actions. Danger only to confirm destruction. Loading keeps the width and full colour; disabled fades."
      id="buttons"
      title="Buttons"
    >
      <Row label="Primary">
        <Button>Save changes</Button>
        <Button className={FORCED.primaryHover}>Hover</Button>
        <Button className={FORCED.primaryPressed}>Pressed</Button>
        <Button className={FORCED.focus}>Focus</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Saving</Button>
      </Row>
      <Row label="Secondary">
        <Button variant="secondary">Cancel</Button>
        <Button className={FORCED.secondaryHover} variant="secondary">
          Hover
        </Button>
        <Button icon={<Upload aria-hidden="true" />} variant="secondary">
          With icon
        </Button>
        <Button iconAfter={<ChevronDown aria-hidden="true" />} variant="secondary">
          Icon after
        </Button>
        <Button aria-pressed selected variant="secondary">
          Selected
        </Button>
        <Button disabled variant="secondary">
          Disabled
        </Button>
        <Button loading variant="secondary">
          Loading
        </Button>
      </Row>
      <Row label="Ghost">
        <Button variant="ghost">Clear filters</Button>
        <Button className={FORCED.ghostHover} variant="ghost">
          Hover
        </Button>
        <Button aria-pressed selected variant="ghost">
          Selected
        </Button>
        <Tooltip label="More actions">
          <Button aria-label="More actions" icon={<MoreHorizontal aria-hidden="true" />} iconOnly variant="ghost" />
        </Tooltip>
        <Tooltip label="Copy">
          <Button aria-label="Copy" icon={<Copy aria-hidden="true" />} iconOnly variant="ghost" />
        </Tooltip>
        <Button disabled variant="ghost">
          Disabled
        </Button>
      </Row>
      <Row label="Destructive">
        <Button variant="danger">Archive</Button>
        <Button className={FORCED.dangerHover} variant="danger">
          Hover
        </Button>
        <Button loading variant="danger">
          Archiving
        </Button>
        <Button disabled variant="danger">
          Disabled
        </Button>
        <Button variant="danger-ghost">Remove member</Button>
      </Row>
      <Row label="Link">
        <Button variant="link">Link action</Button>
        <ButtonLink href="/knowledge" variant="link">
          Open Knowledge
        </ButtonLink>
        <ButtonLink href="/knowledge">Button link</ButtonLink>
      </Row>
      <Row label="Sizes">
        <Button size="sm">Small</Button>
        <Button>Medium</Button>
        <Button size="lg">Large</Button>
        <Button size="sm" variant="secondary">
          Small
        </Button>
        <Button variant="secondary">Medium</Button>
        <Button size="lg" variant="secondary">
          Large
        </Button>
      </Row>
      <Row label="Icon-only">
        <Button aria-label="Add, small" icon={<Plus aria-hidden="true" />} iconOnly size="sm" variant="secondary" />
        <Button aria-label="Add, medium" icon={<Plus aria-hidden="true" />} iconOnly variant="secondary" />
        <Button aria-label="Add, large" icon={<Plus aria-hidden="true" />} iconOnly size="lg" variant="secondary" />
        <Button aria-label="Add" icon={<Plus aria-hidden="true" />} iconOnly />
        <Button aria-label="Adding" icon={<Plus aria-hidden="true" />} iconOnly loading />
      </Row>
      <Row label="Block">
        <div className="w-full max-w-[320px]">
          <Button block>Continue</Button>
        </div>
      </Row>
    </Section>
  );
}

export function InputsSection() {
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Section
      description="Visible labels, help below, errors under the field with the fix. Optional fields say so; required ones carry no marker."
      id="inputs"
      title="Inputs"
    >
      <Grid className="gap-y-5 [&>*]:content-start" cols={3}>
        <FormField help="Shown to everyone in the workspace." htmlFor="ds-name" label="Name" required>
          <Input onChange={(event) => setName(event.target.value)} placeholder="HR Policies" value={name} />
        </FormField>
        <FormField htmlFor="ds-focused" label="Focused" required>
          <Input className={FORCED.fieldFocus} defaultValue="Sales Playbooks" />
        </FormField>
        <FormField error="A knowledge base named “HR Policies” already exists." htmlFor="ds-error" label="With error" required>
          <Input defaultValue="HR Policies" error />
        </FormField>
        <FormField htmlFor="ds-disabled" label="Disabled" required>
          <Input defaultValue="Managed by Google" disabled />
        </FormField>
        <FormField help="Set by the workspace owner." htmlFor="ds-readonly" label="Read-only" required>
          <Input defaultValue="northwind" readOnly />
        </FormField>
        <FormField htmlFor="ds-select" label="Select" required>
          <Select
            defaultValue="viewer"
            options={[
              { value: "viewer", label: "Viewer" },
              { value: "editor", label: "Editor" },
              { value: "owner", label: "Owner" },
            ]}
          />
        </FormField>
        <FormField error="Choose who can see it." htmlFor="ds-select-error" label="Select with placeholder" required>
          <Select
            defaultValue=""
            error
            options={[
              { value: "everyone", label: "Everyone in the workspace" },
              { value: "people", label: "Only people I add" },
            ]}
            placeholder="Choose access"
          />
        </FormField>
        <FormField help="Letters, numbers and dashes." htmlFor="ds-prefix" label="Prefix" required>
          <Input defaultValue="northwind" prefix="bomesh.app/" />
        </FormField>
        <FormField htmlFor="ds-suffix" label="Suffix" required>
          <Input defaultValue="30" inputMode="numeric" suffix="days" />
        </FormField>
        <div className="grid content-start gap-1.5">
          {/* Search fields carry their own accessible name and no visible label. */}
          <span aria-hidden="true" className={ui.label}>
            Search
          </span>
          <SearchInput ariaLabel="Search documents" onChange={setSearch} placeholder="Search documents" value={search} />
        </div>
        <FormField htmlFor="ds-description" label="Description">
          <Textarea
            counterLimit={200}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What belongs here?"
            rows={2}
            value={description}
          />
        </FormField>
        <FormField htmlFor="ds-over" label="Over the counter limit">
          <Textarea
            counterLimit={40}
            defaultValue="Policies, handbooks and forms for every employee in Vietnam."
            rows={2}
          />
        </FormField>
      </Grid>
      <Group className="mt-6" title="Sizes">
        <div className="flex flex-wrap items-center gap-3">
          <Input aria-label="Small input" className="w-48" placeholder="Small · 30" size="sm" />
          <Input aria-label="Medium input" className="w-48" placeholder="Medium · 36" />
          <Input aria-label="Large input" className="w-48" placeholder="Large · 42" size="lg" />
          <SearchInput ariaLabel="Small search" className="w-56" onChange={() => undefined} placeholder="Small search" size="sm" value="" />
        </div>
      </Group>
    </Section>
  );
}

type Frequency = "daily" | "weekly" | "monthly";
type Length = "concise" | "balanced" | "detailed";
type Access = "everyone" | "people";
type Period = "day" | "week" | "month";
type View = "list" | "grid";

export function SelectionSection() {
  const [checked, setChecked] = useState(true);
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [length, setLength] = useState<Length>("balanced");
  const [access, setAccess] = useState<Access>("everyone");
  const [on, setOn] = useState(true);
  const [period, setPeriod] = useState<Period>("week");
  const [view, setView] = useState<View>("list");
  const [webSearch, setWebSearch] = useState(true);

  return (
    <Section description="Checkbox, radio, switch, segmented control and choice cards." id="selection" title="Selection">
      <Row label="Checkbox" className="gap-5">
        <Checkbox checked={checked} label="Checked" onCheckedChange={setChecked} />
        <Checkbox defaultChecked={false} label="Unchecked" />
        <Checkbox indeterminate label="Partial" />
        <Checkbox aria-invalid label="Invalid" />
        <Checkbox disabled label="Disabled" />
        <Checkbox defaultChecked disabled label="Disabled, checked" />
        <Checkbox description="Members get a weekly digest." label="With description" />
      </Row>
      <Row label="Radio">
        <RadioGroup
          aria-label="Sync frequency"
          onChange={setFrequency}
          options={[
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly", disabled: true },
          ]}
          orientation="horizontal"
          value={frequency}
        />
      </Row>
      <Row label="Radio, vertical">
        <RadioGroup
          label="Answer length"
          onChange={setLength}
          options={[
            { value: "concise", label: "Concise", description: "A few sentences." },
            { value: "balanced", label: "Balanced", description: "Short paragraphs with the key facts." },
            { value: "detailed", label: "Detailed", description: "Unavailable for this workspace.", disabled: true },
          ]}
          value={length}
        />
      </Row>
      <Row label="Switch">
        <Switch checked={on} label="Demo switch" onChange={setOn} />
        <span className="text-text-secondary">{on ? "On" : "Off"}</span>
        <Switch checked disabled label="Disabled, on" />
        <span className="text-text-tertiary">Disabled</span>
        <Switch checked={false} disabled label="Disabled, off" />
        <span className="text-text-tertiary">Disabled, off</span>
      </Row>
      <Row label="Segmented">
        <SegmentedControl
          ariaLabel="Period"
          onChange={setPeriod}
          options={[
            { value: "day", label: "Last 24 hours" },
            { value: "week", label: "7 days" },
            { value: "month", label: "30 days" },
          ]}
          value={period}
        />
        <SegmentedControl
          ariaLabel="Layout"
          onChange={setView}
          options={[
            { value: "list", label: "", icon: <List aria-hidden="true" />, ariaLabel: "List" },
            { value: "grid", label: "", icon: <LayoutGrid aria-hidden="true" />, ariaLabel: "Grid" },
          ]}
          size="sm"
          value={view}
        />
      </Row>
      <Grid className="mt-3" cols={2}>
        <ChoiceCard
          checked={access === "everyone"}
          description="All members can find and ask about it."
          name="ds-access"
          onChange={() => setAccess("everyone")}
          title="Everyone in Northwind Group"
        />
        <ChoiceCard
          checked={access === "people"}
          description="Restricted. Others can request access."
          name="ds-access"
          onChange={() => setAccess("people")}
          title="Only people I add"
        />
        <ChoiceCard
          checked={webSearch}
          description="Answers may cite public pages."
          icon={<Globe aria-hidden="true" className="mt-0.5 size-4 text-text-tertiary" />}
          onChange={(event) => setWebSearch(event.target.checked)}
          title="Web search"
          type="checkbox"
        />
        <Specimen caption="Disabled">
          <ChoiceCard
            description="Not available on this plan."
            disabled
            icon={<BarChart3 aria-hidden="true" className="mt-0.5 size-4 text-text-tertiary" />}
            title="Charts"
            type="checkbox"
          />
        </Specimen>
      </Grid>
    </Section>
  );
}
