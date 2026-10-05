import 'package:flutter/material.dart';

import '../../../core/api_client.dart';
import '../../../ui/ui.dart';
import '../../auth/session.dart';
import '../../knowledge/knowledge_models.dart';
import 'ingestion_models.dart';

const _notSearchable = ['pending', 'outdated', 'failed'];
const _everything = ['pending', 'outdated', 'failed', 'ready'];

/// "Make documents searchable": pick a collection and what to process, then
/// start one run. Resolves to the new run's id.
Future<String?> showNewRunSheet(
  BuildContext context, {
  required ApiClient api,
  required AuthSession session,
  required RunNames names,
}) => showAppSheet<String>(
  context,
  title: 'Make documents searchable',
  subtitle: 'One run processes them in the background.',
  builder: (_) => _NewRunBody(api: api, session: session, names: names),
);

class _NewRunBody extends StatefulWidget {
  const _NewRunBody({
    required this.api,
    required this.session,
    required this.names,
  });
  final ApiClient api;
  final AuthSession session;
  final RunNames names;

  @override
  State<_NewRunBody> createState() => _NewRunBodyState();
}

class _NewRunBodyState extends State<_NewRunBody> {
  List<KnowledgeCollection>? _collections;
  Object? _loadError;
  KnowledgeCollection? _selected;
  bool _everythingSelected = false;
  bool _starting = false;
  Object? _startError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final rows = await readAllPages(widget.api, '/collections');
      final all = rows.map(KnowledgeCollection.fromJson).toList();
      for (final collection in all) {
        widget.names.rememberCollection(collection.id, collection.title);
      }
      final runnable = all
          .where(
            (collection) =>
                collection.status != 'archived' &&
                (widget.session.can('ingestion.run') ||
                    collection.can('ingestion.run')),
          )
          .toList();
      if (!mounted) return;
      setState(() {
        _collections = runnable;
        _selected = runnable.isEmpty ? null : runnable.first;
      });
    } catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  Future<void> _pickCollection() async {
    final collections = _collections ?? const [];
    final picked = await showAppSheet<KnowledgeCollection>(
      context,
      title: 'Collection',
      scrollable: true,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final collection in collections)
            SheetOption(
              icon: Icons.menu_book_outlined,
              tone: toneFor(collection.id),
              title: collection.title,
              subtitle: countOf(collection.documentCount, 'document'),
              selected: collection.id == _selected?.id,
              onTap: () => Navigator.pop(sheetContext, collection),
            ),
        ],
      ),
    );
    if (picked != null && mounted) {
      setState(() {
        _selected = picked;
        _startError = null;
      });
    }
  }

  Future<void> _start() async {
    final collection = _selected;
    if (collection == null) return;
    setState(() {
      _starting = true;
      _startError = null;
    });
    try {
      final run = await widget.api.post(
        '/ingestion-runs',
        body: {
          'collection_id': collection.id,
          'states': _everythingSelected ? _everything : _notSearchable,
          'trigger': 'manual',
        },
      );
      if (mounted) Navigator.pop(context, textOf(run['id']));
    } catch (error) {
      if (mounted) {
        setState(() {
          _starting = false;
          _startError = error;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return ErrorView(error: _loadError!, onRetry: _load);
    }
    final collections = _collections;
    if (collections == null) return const LoadingView();
    if (collections.isEmpty) {
      return const EmptyView(
        icon: Icons.menu_book_outlined,
        title: 'No collection to process',
        message: 'You can make documents searchable in collections you edit.',
      );
    }
    final selected = _selected!;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectRow(
          label: 'Collection',
          value: selected.title,
          icon: Icons.menu_book_outlined,
          tone: toneFor(selected.id),
          onTap: collections.length > 1 ? _pickCollection : null,
        ),
        const SizedBox(height: 8),
        SheetOption(
          icon: Icons.auto_awesome_rounded,
          tone: Tone.violet,
          title: 'Not searchable yet',
          subtitle: 'New, changed or failed documents',
          selected: !_everythingSelected,
          onTap: () => setState(() => _everythingSelected = false),
        ),
        SheetOption(
          icon: Icons.refresh_rounded,
          tone: Tone.slate,
          title: 'Everything',
          subtitle:
              '${countOf(selected.documentCount, 'document')} — rebuild the whole collection',
          selected: _everythingSelected,
          onTap: () => setState(() => _everythingSelected = true),
        ),
        if (_startError != null) ...[
          const SizedBox(height: 8),
          InlineNotice(
            text: friendlyError(_startError!),
            icon: Icons.info_outline_rounded,
            tone: StatusTone.warning,
          ),
        ],
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _starting ? null : _start,
          icon: _starting
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.play_arrow_rounded, size: 20),
          label: const Text('Start run'),
        ),
      ],
    );
  }
}
