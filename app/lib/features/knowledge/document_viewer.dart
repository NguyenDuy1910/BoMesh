import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../../core/api_client.dart';
import '../../ui/ui.dart';
import 'knowledge_models.dart';

/// Recently read renditions, by document and version: stepping between
/// citations of one document never downloads it twice.
final _renditions = <String, Future<DocumentRendition>>{};

/// Read one document version's rendition straight from storage. The signed
/// URL carries its own authorisation; storage serves it with
/// `Content-Encoding: gzip`, so the body arrives decoded.
Future<DocumentRendition> loadRendition(
  String documentId,
  KnowledgeViewer viewer,
) {
  final key = '$documentId:${viewer.renditionVersion}';
  final cached = _renditions.remove(key);
  if (cached != null) return _renditions[key] = cached;
  final download = () async {
    final response = await http.get(Uri.parse(viewer.renditionUrl));
    if (response.statusCode != 200) {
      throw ApiException(
        'The document’s text couldn’t be loaded (${response.statusCode}).',
      );
    }
    return DocumentRendition.fromJson(
      objectOf(jsonDecode(utf8.decode(response.bodyBytes))),
    );
  }();
  // A failed download is forgotten, so the next read retries it.
  download.then<void>(
    (_) {},
    onError: (Object _) {
      if (identical(_renditions[key], download)) _renditions.remove(key);
    },
  );
  _renditions[key] = download;
  while (_renditions.length > 8) {
    _renditions.remove(_renditions.keys.first);
  }
  return download;
}

/// The passage an answer cited, as a quote with Copy.
class CitedPassage extends StatelessWidget {
  const CitedPassage({super.key, required this.text, this.section = ''});
  final String text, section;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 6, 6, 14),
      decoration: BoxDecoration(
        color: colors.brandSoft,
        borderRadius: BorderRadius.circular(14),
        border: Border(left: BorderSide(color: colors.brand, width: 3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  section.isEmpty ? 'Cited passage' : section,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.brandInk,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Copy passage',
                visualDensity: VisualDensity.compact,
                icon: Icon(Icons.copy_rounded, size: 18, color: colors.ink3),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: text));
                  if (context.mounted) showToast(context, 'Passage copied');
                },
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: SelectableText(
              text,
              style: TextStyle(color: colors.ink, fontSize: 15, height: 1.55),
            ),
          ),
        ],
      ),
    );
  }
}

/// The whole document read from its rendition, block by block.
///
/// Built lazily, so a long file or a large sheet stays cheap. Cited blocks
/// and cited table rows are highlighted; [firstCitedKey] marks the first one
/// so the page can scroll to it.
class RenditionSliver extends StatelessWidget {
  const RenditionSliver({
    super.key,
    required this.rendition,
    required this.spreadsheet,
    required this.citedBlocks,
    required this.citedRows,
    this.firstCitedKey,
  });
  final DocumentRendition rendition;
  final bool spreadsheet;
  final Set<String> citedBlocks;
  final Map<String, Set<int>> citedRows;
  final GlobalKey? firstCitedKey;

  @override
  Widget build(BuildContext context) {
    final blocks = rendition.blocks;
    if (blocks.isEmpty) {
      return const SliverToBoxAdapter(
        child: _Note('This document has no readable text.'),
      );
    }
    final pages = {
      for (final block in blocks)
        if (block.page != null) block.page!,
    };
    // Sheets are named on their tables; pages get a quiet separator.
    final separators = !spreadsheet && pages.length > 1;
    final firstCited = blocks.indexWhere(
      (block) => citedBlocks.contains(block.id),
    );
    final count = blocks.length + (rendition.truncated ? 1 : 0);
    return SliverList.builder(
      itemCount: count,
      itemBuilder: (context, index) {
        if (index >= blocks.length) {
          return const _Note(
            'Showing the first part of this file. Download it for the rest.',
          );
        }
        final block = blocks[index];
        final previous = index > 0 ? blocks[index - 1].page : null;
        final separator =
            separators &&
            block.page != null &&
            (index == 0 || block.page != previous);
        final cited = citedBlocks.contains(block.id);
        return Padding(
          key: index == firstCited ? firstCitedKey : null,
          padding: const EdgeInsets.only(bottom: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (separator) _PageSeparator('Page ${block.page}'),
              _Block(
                block: block,
                cited: cited && !citedRows.containsKey(block.id),
                citedRows: citedRows[block.id] ?? const {},
                sheetLabel: spreadsheet && block.page != null
                    ? 'Sheet ${block.page}'
                          '${pages.length > 1 ? ' of ${pages.length}' : ''}'
                    : null,
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Block extends StatelessWidget {
  const _Block({
    required this.block,
    required this.cited,
    required this.citedRows,
    this.sheetLabel,
  });
  final RenditionBlock block;
  final bool cited;
  final Set<int> citedRows;
  final String? sheetLabel;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final child = switch (block.kind) {
      'heading' => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: SelectableText(
          block.text,
          style: switch (block.level) {
            1 => TextStyle(
              color: colors.ink,
              fontSize: 19,
              fontWeight: FontWeight.w700,
              height: 1.3,
            ),
            2 => TextStyle(
              color: colors.ink,
              fontSize: 17,
              fontWeight: FontWeight.w700,
              height: 1.3,
            ),
            3 => TextStyle(
              color: colors.ink,
              fontSize: 15.5,
              fontWeight: FontWeight.w600,
              height: 1.35,
            ),
            _ => TextStyle(
              color: colors.ink2,
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              height: 1.35,
            ),
          },
        ),
      ),
      'table' => TableBlockView(
        block: block,
        citedRows: citedRows,
        sheetLabel: sheetLabel,
      ),
      'code' => Container(
        decoration: BoxDecoration(
          color: colors.codeSurface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.all(12),
          child: SelectableText(
            block.text,
            style: TextStyle(
              color: colors.codeText,
              fontFamily: 'monospace',
              fontSize: 12.5,
              height: 1.5,
            ),
          ),
        ),
      ),
      'image' => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: colors.line),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.image_outlined, size: 18, color: colors.ink3),
            const SizedBox(width: 8),
            Expanded(
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: 'Image  ',
                      style: TextStyle(
                        color: colors.ink2,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    TextSpan(text: block.text),
                  ],
                ),
                style: TextStyle(color: colors.ink3, fontSize: 13.5),
              ),
            ),
          ],
        ),
      ),
      'link' => Align(
        alignment: Alignment.centerLeft,
        child: InkWell(
          onTap: () => _openLink(context, block.url),
          borderRadius: BorderRadius.circular(6),
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(text: block.text.isEmpty ? block.url : block.text),
                const WidgetSpan(child: SizedBox(width: 4)),
                WidgetSpan(
                  alignment: PlaceholderAlignment.middle,
                  child: Icon(
                    Icons.open_in_new_rounded,
                    size: 14,
                    color: colors.brandInk,
                  ),
                ),
              ],
            ),
            style: TextStyle(
              color: colors.brandInk,
              fontSize: 15,
              fontWeight: FontWeight.w600,
              decoration: TextDecoration.underline,
              decorationColor: colors.brandInk,
            ),
          ),
        ),
      ),
      _ => SelectableText(
        block.text,
        style: TextStyle(color: colors.ink, fontSize: 15, height: 1.6),
      ),
    };
    if (!cited) return child;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: colors.brandSoft,
        borderRadius: BorderRadius.circular(10),
      ),
      child: child,
    );
  }
}

Future<void> _openLink(BuildContext context, String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || !const ['http', 'https'].contains(uri.scheme)) {
    showToast(context, 'This link can’t be opened.');
    return;
  }
  final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!opened && context.mounted) {
    showToast(context, 'No app could open this link.');
  }
}

/// A table as a rounded outlined grid: a header row and a row-number column,
/// scrolling sideways when wider than the screen. Long tables show their
/// first rows and grow on request; cited rows are always shown.
class TableBlockView extends StatefulWidget {
  const TableBlockView({
    super.key,
    required this.block,
    this.citedRows = const {},
    this.sheetLabel,
  });
  final RenditionBlock block;
  final Set<int> citedRows;
  final String? sheetLabel;

  @override
  State<TableBlockView> createState() => _TableBlockViewState();
}

class _TableBlockViewState extends State<TableBlockView> {
  static const _step = 100;
  late int _shown = _initial();

  int _initial() {
    final last = widget.citedRows.isEmpty
        ? 0
        : widget.citedRows.reduce((a, b) => a > b ? a : b) + 1;
    return last > _step ? last : _step;
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final block = widget.block;
    final columnCount = [
      block.columns.length,
      for (final row in block.rows) row.length,
    ].fold<int>(0, (a, b) => a > b ? a : b);
    final rows = block.rows.take(_shown).toList();
    final total = block.totalRows > block.rows.length
        ? block.totalRows
        : block.rows.length;
    final caption = [
      ?widget.sheetLabel,
      countOf(total, 'row'),
      if (block.rows.length < total)
        'first ${groupedNumber(block.rows.length)} here',
    ].join(' · ');
    const numberWidth = 36.0;
    final style = TextStyle(color: colors.ink, fontSize: 13.5, height: 1.3);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (block.caption.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              block.caption,
              style: TextStyle(
                color: colors.ink2,
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        if (columnCount > 0)
          LayoutBuilder(
            builder: (context, constraints) {
              // Natural widths from the header and the first rows, widened
              // to fill the screen when the table is narrower than it.
              final widths = List<double>.generate(columnCount, (column) {
                var longest = column < block.columns.length
                    ? block.columns[column].length
                    : 0;
                for (final row in block.rows.take(40)) {
                  if (column < row.length && row[column].length > longest) {
                    longest = row[column].length;
                  }
                }
                return (longest * 7.6 + 18).clamp(64.0, 240.0);
              });
              final natural = widths.fold<double>(numberWidth, (a, b) => a + b);
              final available = constraints.maxWidth - 2;
              if (natural < available) {
                final scale =
                    (available - numberWidth) / (natural - numberWidth);
                for (var index = 0; index < widths.length; index++) {
                  widths[index] *= scale;
                }
              }
              Widget cell(
                String text,
                double width, {
                bool head = false,
                bool number = false,
              }) => Container(
                width: width,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
                color: head || number ? colors.subtle : null,
                alignment: number ? Alignment.center : Alignment.centerLeft,
                child: Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: number
                      ? style.copyWith(color: colors.ink3, fontSize: 12.5)
                      : head
                      ? style.copyWith(fontWeight: FontWeight.w700)
                      : style,
                ),
              );
              Widget line(List<Widget> cells, {Color? background}) =>
                  DecoratedBox(
                    decoration: BoxDecoration(color: background),
                    child: Row(mainAxisSize: MainAxisSize.min, children: cells),
                  );
              return Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: colors.line),
                ),
                clipBehavior: Clip.antiAlias,
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (block.columns.isNotEmpty)
                        line([
                          cell('', numberWidth, head: true),
                          for (var column = 0; column < columnCount; column++)
                            cell(
                              column < block.columns.length
                                  ? block.columns[column]
                                  : '',
                              widths[column],
                              head: true,
                            ),
                        ]),
                      for (var index = 0; index < rows.length; index++) ...[
                        if (index > 0 || block.columns.isNotEmpty)
                          SizedBox(
                            width: widths.fold<double>(
                              numberWidth,
                              (a, b) => a + b,
                            ),
                            child: Divider(height: 1, color: colors.line),
                          ),
                        line(
                          [
                            cell('${index + 1}', numberWidth, number: true),
                            for (var column = 0; column < columnCount; column++)
                              cell(
                                column < rows[index].length
                                    ? rows[index][column]
                                    : '',
                                widths[column],
                              ),
                          ],
                          background: widget.citedRows.contains(index)
                              ? colors.brandSoft
                              : null,
                        ),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  caption,
                  style: TextStyle(color: colors.ink3, fontSize: 13),
                ),
              ),
              if (_shown < block.rows.length)
                TextButton(
                  onPressed: () => setState(() => _shown += _step * 5),
                  child: const Text('Show more rows'),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// The indexed text of a document without a rendition, part by part.
class ElementsSliver extends StatelessWidget {
  const ElementsSliver({
    super.key,
    required this.elements,
    required this.cited,
    this.firstCitedKey,
  });
  final List<ViewerElement> elements;
  final Set<String> cited;
  final GlobalKey? firstCitedKey;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final firstCited = elements.indexWhere(
      (element) => cited.contains(element.id),
    );
    return SliverList.builder(
      itemCount: elements.length + 1,
      itemBuilder: (context, index) {
        if (index == elements.length) {
          return const _Note(
            'The indexed text. Long documents may show only part of it; the original has the whole file.',
          );
        }
        final element = elements[index];
        final label = [
          if (element.page > 0) 'Page ${element.page}',
          if (element.section.isNotEmpty) element.section,
        ].join(' · ');
        final highlighted = cited.contains(element.id);
        return Container(
          key: index == firstCited ? firstCitedKey : null,
          margin: const EdgeInsets.only(bottom: 10),
          padding: highlighted
              ? const EdgeInsets.symmetric(horizontal: 10, vertical: 8)
              : EdgeInsets.zero,
          decoration: highlighted
              ? BoxDecoration(
                  color: colors.brandSoft,
                  borderRadius: BorderRadius.circular(10),
                )
              : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (label.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    label,
                    style: TextStyle(
                      color: colors.ink3,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              SelectableText(
                element.text,
                style: TextStyle(color: colors.ink, fontSize: 15, height: 1.6),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The document's own page images, one at a time, zoomable, with the cited
/// regions highlighted.
class PageViewer extends StatefulWidget {
  const PageViewer({super.key, required this.viewer, required this.onRetry});
  final KnowledgeViewer viewer;
  final VoidCallback onRetry;

  @override
  State<PageViewer> createState() => _PageViewerState();
}

class _PageViewerState extends State<PageViewer> {
  late int _index = _focusIndex();

  int _focusIndex() {
    final index = widget.viewer.assets.indexWhere(
      (asset) => asset.page == widget.viewer.focusPage,
    );
    return index < 0 ? 0 : index;
  }

  @override
  void didUpdateWidget(covariant PageViewer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_index >= widget.viewer.assets.length) _index = 0;
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final viewer = widget.viewer;
    final asset = viewer.assets[_index];
    final number = asset.page > 0 ? asset.page : _index + 1;
    final regions = viewer.normalizedCoordinates
        ? viewer.regions
              .where(
                (region) =>
                    region.page == asset.page &&
                    region.width > 0 &&
                    region.height > 0,
              )
              .toList()
        : const <CitationRegion>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          decoration: BoxDecoration(
            color: colors.subtle,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: colors.line),
          ),
          clipBehavior: Clip.antiAlias,
          child: AspectRatio(
            aspectRatio: asset.width > 0 && asset.height > 0
                ? asset.width / asset.height
                : .707,
            child: InteractiveViewer(
              minScale: 1,
              maxScale: 5,
              child: LayoutBuilder(
                builder: (context, constraints) => Image.network(
                  asset.url,
                  key: ValueKey(asset.url),
                  width: constraints.maxWidth,
                  height: constraints.maxHeight,
                  fit: BoxFit.contain,
                  semanticLabel: '${viewer.title}, page $number',
                  loadingBuilder: (context, child, progress) =>
                      progress == null ? child : const LoadingView(),
                  errorBuilder: (context, error, stack) => Center(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: InlineNotice(
                        text: 'This page couldn’t be loaded.',
                        actionLabel: 'Try again',
                        onAction: widget.onRetry,
                      ),
                    ),
                  ),
                  frameBuilder: (context, child, frame, synchronous) {
                    if (frame == null && !synchronous) return child;
                    return Stack(
                      fit: StackFit.expand,
                      children: [
                        child,
                        for (final region in regions)
                          Positioned(
                            left: region.x * constraints.maxWidth,
                            top: region.y * constraints.maxHeight,
                            width: region.width * constraints.maxWidth,
                            height: region.height * constraints.maxHeight,
                            child: IgnorePointer(
                              child: ColoredBox(
                                color: colors.brand.withValues(alpha: .2),
                              ),
                            ),
                          ),
                      ],
                    );
                  },
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            IconButton(
              tooltip: 'Previous page',
              onPressed: _index > 0 ? () => setState(() => _index--) : null,
              icon: const Icon(Icons.chevron_left_rounded),
            ),
            Expanded(
              child: Text(
                'Page $number'
                '${viewer.pageCount > 0 ? ' of ${viewer.pageCount}' : ''}',
                textAlign: TextAlign.center,
                style: TextStyle(color: colors.ink3, fontSize: 13),
              ),
            ),
            IconButton(
              tooltip: 'Next page',
              onPressed: _index + 1 < viewer.assets.length
                  ? () => setState(() => _index++)
                  : null,
              icon: const Icon(Icons.chevron_right_rounded),
            ),
          ],
        ),
        if (viewer.truncated)
          const _Note(
            'Only some pages have a preview. Download the file for all of it.',
          ),
      ],
    );
  }
}

class _PageSeparator extends StatelessWidget {
  const _PageSeparator(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 10),
      child: Row(
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(
              color: colors.ink3,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(child: Divider(height: 1, color: colors.line)),
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Text(
      text,
      style: TextStyle(color: context.colors.ink3, fontSize: 13, height: 1.4),
    ),
  );
}
