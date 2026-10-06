import 'package:flutter/material.dart';

import '../../ui/ui.dart';
import 'document_page.dart';
import 'knowledge_models.dart';

/// One file: its type tile, its name, and one quiet meta line —
/// "XLSX · 15 KB · yesterday". Only a file that cannot be searched yet says
/// so, in the place of its date. No badges, no buttons: tapping opens it.
class DocumentRow extends StatelessWidget {
  const DocumentRow({
    super.key,
    required this.document,
    this.onTap,
    this.onReturn,
  });
  final KnowledgeDocument document;

  /// Replaces opening the document.
  final VoidCallback? onTap;

  /// Called after the opened document closes, so the list can refresh.
  final VoidCallback? onReturn;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final processing = document.processing;
    final facts = [
      FileKind.typeWord(contentType: document.contentType, name: document.name),
      if (document.size > 0) readableBytes(document.size),
    ].join(' · ');
    final (String last, Color? tone) = processing.isProcessing
        ? ('Becoming searchable…', null)
        : processing.notSearchable
        ? ('Not searchable yet', colors.warning)
        : (relativeTime(document.updatedAt), null);
    return ListRow(
      leading: FileTile(contentType: document.contentType, name: document.name),
      title: document.name,
      subtitleWidget: Text.rich(
        TextSpan(
          children: [
            TextSpan(text: last.isEmpty ? facts : '$facts · '),
            if (last.isNotEmpty)
              TextSpan(
                text: last,
                style: tone == null ? null : TextStyle(color: tone),
              ),
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      onTap:
          onTap ??
          () async {
            await Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => DocumentPage(documentId: document.id),
              ),
            );
            onReturn?.call();
          },
    );
  }
}

/// A collection as a shelf: its colour, name, what it is for, and a few facts.
class CollectionCard extends StatelessWidget {
  const CollectionCard({
    super.key,
    required this.collection,
    this.onTap,
    this.children,
  });
  final KnowledgeCollection collection;
  final VoidCallback? onTap;

  /// How many collections sit inside it, when known.
  final int? children;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      color: colors.canvas,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ToneTile(
                tone: toneFor(collection.id),
                icon: Icons.menu_book_outlined,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      collection.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15.5,
                        fontWeight: FontWeight.w700,
                        height: 1.3,
                      ),
                    ),
                    if (collection.description.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        collection.description,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: colors.ink2,
                          fontSize: 13.5,
                          height: 1.4,
                        ),
                      ),
                    ],
                    const SizedBox(height: 8),
                    CollectionFacts(collection: collection, children: children),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "271 items · 1 collection · Synced" as small icon facts.
class CollectionFacts extends StatelessWidget {
  const CollectionFacts({super.key, required this.collection, this.children});
  final KnowledgeCollection collection;
  final int? children;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    Widget fact(IconData icon, String text) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: colors.ink3),
        const SizedBox(width: 4),
        Text(text, style: TextStyle(color: colors.ink3, fontSize: 12.5)),
      ],
    );
    return Wrap(
      spacing: 12,
      runSpacing: 4,
      children: [
        fact(
          Icons.insert_drive_file_outlined,
          countOf(collection.documentCount, 'item'),
        ),
        if ((children ?? 0) > 0)
          fact(Icons.menu_book_outlined, countOf(children!, 'collection')),
        if (collection.sourceCount > 0) fact(Icons.refresh_rounded, 'Synced'),
      ],
    );
  }
}

/// A collection's name and description, for creating or editing one.
/// Resolves to the entered values, or null when dismissed.
Future<({String title, String description})?> showCollectionForm(
  BuildContext context, {
  required String title,
  String? subtitle,
  String initialTitle = '',
  String initialDescription = '',
  required String confirmLabel,
}) => showAppSheet<({String title, String description})>(
  context,
  title: title,
  subtitle: subtitle,
  builder: (_) => _CollectionForm(
    initialTitle: initialTitle,
    initialDescription: initialDescription,
    confirmLabel: confirmLabel,
  ),
);

class _CollectionForm extends StatefulWidget {
  const _CollectionForm({
    required this.initialTitle,
    required this.initialDescription,
    required this.confirmLabel,
  });
  final String initialTitle, initialDescription, confirmLabel;

  @override
  State<_CollectionForm> createState() => _CollectionFormState();
}

class _CollectionFormState extends State<_CollectionForm> {
  late final _title = TextEditingController(text: widget.initialTitle);
  late final _description = TextEditingController(
    text: widget.initialDescription,
  );

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  bool get _valid => _title.text.trim().isNotEmpty;

  void _submit() {
    if (!_valid) return;
    Navigator.pop(context, (
      title: _title.text.trim(),
      description: _description.text.trim(),
    ));
  }

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _title,
          autofocus: widget.initialTitle.isEmpty,
          maxLength: 255,
          textInputAction: TextInputAction.next,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(labelText: 'Name', counterText: ''),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _description,
          minLines: 2,
          maxLines: 4,
          maxLength: 2000,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(
            labelText: 'What it holds',
            counterText: '',
          ),
        ),
        const SizedBox(height: 14),
        FilledButton(
          onPressed: _valid ? _submit : null,
          child: Text(widget.confirmLabel),
        ),
      ],
    ),
  );
}
