"use client";

import clsx from "clsx";
import { Fragment, type ReactNode } from "react";

import type { ContentNode, ContentRun } from "./api";
import { headingTag, safeHref, tableLayout, type LaidCell } from "./blocks";

/**
 * One renderer for a document's Structured Document blocks (GetItemContent `ContentNode`s, preview content.js
 * `nodesHtml`): headings, paragraphs (bold, italic, links), nested lists, tables with merged cells, code,
 * formulas and pictures. Text is document content, drawn as text (never HTML); links go only to http(s) and
 * mailto. Every block carries its `data-ref`; `nodeClassName` adds the caller's class (an artifact diff's status).
 */

interface Marks {
  nodeClassName?: (node: ContentNode) => string | undefined;
}

function Runs({ runs }: { runs: readonly ContentRun[] | undefined }) {
  return (
    <>
      {(runs ?? []).map((run, i) => {
        let out: ReactNode = run.text;
        if (run.italic) out = <em>{out}</em>;
        if (run.bold) out = <strong>{out}</strong>;
        const href = safeHref(run.uri);
        if (href) {
          out = (
            <a className="link" href={href} target="_blank" rel="noreferrer">
              {out}
            </a>
          );
        }
        return <Fragment key={i}>{out}</Fragment>;
      })}
    </>
  );
}

function blockProps(node: ContentNode, base: string, { nodeClassName }: Marks) {
  return {
    className: clsx(base, "cv-block", nodeClassName?.(node)),
    "data-ref": node.ref,
    ...(node.pageNumber ? { "data-page": node.pageNumber } : {}),
  };
}

function Cell({ cell, head }: { cell: LaidCell; head?: boolean }) {
  const Tag = head || cell.header ? "th" : "td";
  return (
    <Tag rowSpan={cell.rowSpan} colSpan={cell.colSpan} scope={head ? "col" : undefined}>
      {cell.text}
    </Tag>
  );
}

function Table({ node, marks }: { node: ContentNode; marks: Marks }) {
  const { head, body, moreRows } = tableLayout(node);
  const caption = [node.sheet, node.caption].filter(Boolean).join(" · ");
  return (
    <figure {...blockProps(node, "cv-table", marks)}>
      <div className="cv-table__scroll">
        <table>
          {head.length ? (
            <thead>
              {head.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <Cell key={c} cell={cell} head />
                  ))}
                </tr>
              ))}
            </thead>
          ) : null}
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <Cell key={c} cell={cell} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
      {moreRows ? <p className="cv-table__more">{`… còn ${moreRows.toLocaleString("vi-VN")} hàng nữa trong bản gốc`}</p> : null}
    </figure>
  );
}

function Picture({ node, marks }: { node: ContentNode; marks: Marks }) {
  const image = node.image;
  const src = safeHref(image?.uri);
  return (
    <figure {...blockProps(node, "cv-picture", marks)}>
      {src ? (
        <img src={src} alt={node.caption ?? ""} width={image?.widthPixels || undefined} height={image?.heightPixels || undefined} loading="lazy" decoding="async" />
      ) : null}
      {node.caption || !src ? (
        <figcaption>
          {node.caption}
          {!src ? <span className="cv-picture__missing">{node.caption ? " · Xem hình ở bản gốc" : "Xem hình ở bản gốc"}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

function List({ node, marks }: { node: ContentNode; marks: Marks }) {
  const Tag = node.ordered ? "ol" : "ul";
  return (
    <Tag {...blockProps(node, "cv-list", marks)}>
      {(node.children ?? []).map((child) => (
        <li key={child.ref} {...blockProps(child, "cv-li", marks)}>
          {child.marker ? (
            <span className="cv-li__marker" aria-hidden>
              {child.marker}
            </span>
          ) : null}
          <span className="cv-li__body">
            <Runs runs={child.runs} />
            {(child.children ?? []).map((nested) => (
              <Block key={nested.ref} node={nested} marks={marks} />
            ))}
          </span>
        </li>
      ))}
    </Tag>
  );
}

function Block({ node, marks }: { node: ContentNode; marks: Marks }) {
  switch (node.kind) {
    case "HEADING": {
      const Tag = headingTag(node.level);
      return (
        <Tag {...blockProps(node, `cv-h cv-h--${Math.min(5, node.level ?? 1)}`, marks)}>
          <Runs runs={node.runs} />
        </Tag>
      );
    }
    case "LIST":
      return <List node={node} marks={marks} />;
    case "LIST_ITEM":
      // A list item outside its list (a window that starts inside one): drawn as a one-item list.
      return <List node={{ ref: `${node.ref}#list`, kind: "LIST", children: [node] }} marks={marks} />;
    case "TABLE":
      return <Table node={node} marks={marks} />;
    case "CODE":
      return (
        <pre {...blockProps(node, "cv-code", marks)} data-lang={node.language || undefined}>
          <code>
            <Runs runs={node.runs} />
          </code>
        </pre>
      );
    case "FORMULA":
      return (
        <div {...blockProps(node, "cv-formula", marks)}>
          <Runs runs={node.runs} />
        </div>
      );
    case "PICTURE":
      return <Picture node={node} marks={marks} />;
    default:
      return (
        <p {...blockProps(node, "cv-p", marks)}>
          <Runs runs={node.runs} />
        </p>
      );
  }
}

export function DocumentRenderer({ nodes, nodeClassName }: { nodes: readonly ContentNode[]; nodeClassName?: (node: ContentNode) => string | undefined }) {
  const marks: Marks = { nodeClassName };
  return (
    <article className="cv-doc" translate="no">
      {nodes.map((node) => (
        <Block key={node.ref} node={node} marks={marks} />
      ))}
    </article>
  );
}
