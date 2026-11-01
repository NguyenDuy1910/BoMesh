"use client";

import { useState } from "react";

import { FileTypeIcon } from "@/modules/knowledge/components/FileTypeIcon";
import { CitationChip } from "@/components/patterns/CitationChip";
import { EvidenceChip } from "@/components/patterns/EvidenceChip";
import { Highlight } from "@/components/patterns/Highlight";
import { Passage } from "@/components/patterns/Passage";
import { Avatar } from "@/components/ui/Avatar";
import { PreviewTag } from "@/components/ui/PreviewTag";

import { Card, Grid, Row, Section } from "./kit";

const SOURCES = ["Travel & Expense Policy.pdf", "Employee Handbook 2026.pdf"] as const;

export function EvidenceSection() {
  const [active, setActive] = useState(2);
  return (
    <Section
      description="The product signature: every claim can be traced to a highlighted passage. Amber appears here and nowhere else."
      id="evidence"
      title="Evidence"
    >
      <Grid cols={2}>
        <Card className="px-4.5 py-4 leading-[1.7]">
          For international travel, the meal per diem is <b className="font-semibold">USD 75 per day</b>{" "}
          <CitationChip active={active === 1} n={1} onClick={() => setActive(1)} title={SOURCES[0]} />. Receipts are due within
          30 days <CitationChip active={active === 2} n={2} onClick={() => setActive(2)} title={SOURCES[1]} />.
          <div className="mt-3 flex flex-wrap gap-1.5">
            {SOURCES.map((title, index) => (
              <EvidenceChip
                icon={<FileTypeIcon decorative kind="pdf" label="PDF" size="sm" />}
                key={title}
                n={index + 1}
                onClick={() => setActive(index + 1)}
                title={title}
              />
            ))}
            <EvidenceChip locked title="Board Minutes March.pdf" />
          </div>
        </Card>
        <Card className="px-4.5 py-4">
          <Passage
            highlight="submitted within 30 days of the employee’s return"
            source={active === 1 ? `${SOURCES[0]} · page 4` : `${SOURCES[1]} · page 31`}
          >
            {active === 1
              ? "International travel is reimbursed at a meal per diem of USD 75 per day, regardless of the city visited."
              : "Expenses for lodging, airfare and ground transportation must be supported by itemized receipts and submitted within 30 days of the employee’s return."}
          </Passage>
          <p className="mt-3 text-body leading-[1.7]">
            In a document: <Highlight focus>the cited sentence is highlighted</Highlight> and scrolled into view; other
            matches use the <Highlight>quiet highlight</Highlight>.
          </p>
        </Card>
      </Grid>
      <Row label="Chips">
        <CitationChip n={3} title="Leave Policy Vietnam.docx" />
        <CitationChip active n={4} title="Code of Conduct.pdf" />
        <EvidenceChip href="/knowledge" n={5} title="Linked source" />
        <EvidenceChip title="Source without a number" />
        <EvidenceChip locked n={6} title="Restricted source" />
      </Row>
    </Section>
  );
}

const PEOPLE = ["Duy Nguyen", "Lan Tran", "Minh Pham", "Hoa Le", "An Vo", "Quang Do"] as const;

export function IdentitySection() {
  return (
    <Section
      description="Avatars keep one colour per person on every screen. The Preview tag marks surfaces whose API is still pending: the data lives in this browser."
      id="identity"
      title="Identity and markers"
    >
      <Row label="Avatar sizes">
        {(["xs", "sm", "rail", "md", "lg", "xl"] as const).map((size) => (
          <span className="inline-flex items-center gap-2 text-meta text-text-tertiary" key={size}>
            <Avatar name="Duy Nguyen" size={size} />
            {size}
          </span>
        ))}
      </Row>
      <Row label="Avatar palette">
        {PEOPLE.map((name) => (
          <span className="inline-flex items-center gap-2 text-body" key={name}>
            <Avatar name={name} size="lg" />
            {name}
          </span>
        ))}
      </Row>
      <Row label="Preview tag">
        <span className="inline-flex items-center gap-2 text-section font-semibold">
          Knowledge gaps <PreviewTag />
        </span>
        <span className="text-meta text-text-tertiary">
          Focus or hover it for the explanation. Hidden when NEXT_PUBLIC_BOMESH_PENDING_MARKER=off.
        </span>
      </Row>
    </Section>
  );
}
