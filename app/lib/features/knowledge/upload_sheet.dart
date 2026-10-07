import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/workspace_scope.dart';
import '../../core/api_client.dart';
import '../../core/uploads.dart';
import '../../ui/ui.dart';
import '../auth/session.dart';
import 'knowledge_models.dart';

/// Upload files: where they go, whether to make them searchable right away,
/// then Choose files — and each file's progress in the same sheet.
///
/// [into] presets the destination; without it the files go to My files (the
/// person's own collection, created on first use). Resolves true when
/// anything was added, so the caller can refresh.
Future<bool> showUploadSheet(
  BuildContext context, {
  KnowledgeCollection? into,
  void Function(String runId)? onQueued,
}) async {
  final scope = WorkspaceScope.of(context);
  final outcome = _Outcome();
  await showAppSheet<void>(
    context,
    title: 'Upload files',
    subtitle: 'Up to 20 files, 100 MB each.',
    builder: (_) => _UploadSheet(
      api: scope.api,
      session: scope.session,
      into: into,
      outcome: outcome,
      onQueued: onQueued,
    ),
  );
  return outcome.added;
}

class _Outcome {
  bool added = false;
}

enum _State { waiting, sending, done, failed }

class _Upload {
  _Upload(this.file) : key = newRequestId();
  final UploadSource file;

  /// Kept for the file's lifetime, so retrying never creates a duplicate.
  final String key;
  _State state = _State.waiting;
  String? error, documentId;
}

class _UploadSheet extends StatefulWidget {
  const _UploadSheet({
    required this.api,
    required this.session,
    required this.into,
    required this.outcome,
    required this.onQueued,
  });
  final ApiClient api;
  final AuthSession session;
  final KnowledgeCollection? into;
  final _Outcome outcome;
  final void Function(String runId)? onQueued;

  @override
  State<_UploadSheet> createState() => _UploadSheetState();
}

class _UploadSheetState extends State<_UploadSheet> {
  /// Collections this person may add to, besides My files; null while loading.
  List<KnowledgeCollection>? _targets;
  Object? _loadError;

  /// My files, once it exists.
  KnowledgeCollection? _personal;
  String _personalId = '';

  /// Where the files go; null means My files before it exists.
  KnowledgeCollection? _target;
  bool _searchable = true;

  List<_Upload> _uploads = const [];
  List<String> _skipped = const [];
  final Set<String> _runFor = {};
  bool _running = false, _choosing = false;
  String? _runError;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    setState(() => _loadError = null);
    try {
      final home = await widget.api.get('/knowledge/home');
      if (!mounted) return;
      final collections = objectList(home['collections'])
          .map(KnowledgeCollection.fromJson)
          .toList();
      final personalId = textOf(home['personal_collection_id']);
      final personal = collections
          .where((collection) => collection.id == personalId)
          .firstOrNull;
      setState(() {
        _personalId = personalId;
        _personal = personal;
        _targets = collections
            .where(
              (collection) =>
                  collection.id != personalId &&
                  collection.status == 'active' &&
                  allowedOn(widget.session, collection, 'collection.update'),
            )
            .toList();
        _target = widget.into ?? personal;
      });
    } catch (error) {
      if (mounted) setState(() => _loadError = error);
    }
  }

  bool get _toMine => _target == null || _target!.id == _personalId;

  String get _targetName => _toMine ? 'My files' : _target!.title;

  bool get _canRun => allowedOn(widget.session, _target, 'ingestion.run');

  Future<void> _pickTarget() async {
    final targets = _targets ?? const [];
    final chosen = await showAppSheet<({KnowledgeCollection? into})>(
      context,
      title: 'Add to',
      scrollable: true,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SheetOption(
            icon: Icons.person_outline_rounded,
            tone: Tone.slate,
            title: 'My files',
            subtitle: 'Only you can open them',
            selected: _toMine,
            onTap: () => Navigator.pop(sheetContext, (into: _personal)),
          ),
          for (final collection in targets)
            SheetOption(
              icon: Icons.menu_book_outlined,
              tone: toneFor(collection.id),
              title: collection.title,
              subtitle: countOf(collection.documentCount, 'item'),
              selected: !_toMine && _target!.id == collection.id,
              onTap: () => Navigator.pop(sheetContext, (into: collection)),
            ),
        ],
      ),
    );
    // My files may not exist yet (null): it is created on upload.
    if (mounted && chosen != null) setState(() => _target = chosen.into);
  }

  Future<void> _choose() async {
    if (_choosing) return;
    setState(() {
      _choosing = true;
      _runError = null;
    });
    try {
      var target = _target;
      if (target == null) {
        // My files is created the first time something goes into it.
        target = KnowledgeCollection.fromJson(
          await widget.api.put('/collections/personal'),
        );
        if (!mounted) return;
        setState(() {
          _personal = target;
          _personalId = target!.id;
          _target = target;
        });
      }
      final PickedUploads picked;
      try {
        picked = await pickUploads(
          extensions: {...knowledgeExtensions, if (!_toMine) 'zip'},
        );
      } catch (error) {
        if (mounted) showToast(context, 'Files couldn’t be opened: $error');
        return;
      }
      if (!mounted || picked.isEmpty) return;
      setState(() {
        _uploads = [for (final file in picked.accepted) _Upload(file)];
        _skipped = picked.rejected;
      });
      if (_uploads.isNotEmpty) await _run();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _choosing = false);
    }
  }

  Future<void> _run() async {
    final target = _target!;
    final searchable = _searchable && _canRun;
    setState(() => _running = true);
    final token = widget.api.accessToken;
    for (final upload in _uploads) {
      if (upload.state == _State.done) continue;
      if (!mounted || token != widget.api.accessToken) return;
      setState(() {
        upload.state = _State.sending;
        upload.error = null;
      });
      try {
        final result = await widget.api.upload(
          '/collections/${Uri.encodeComponent(target.id)}/documents',
          file: upload.file,
          fields: const {'purpose': 'knowledge'},
          idempotencyKey: upload.key,
        );
        widget.outcome.added = true;
        if (!mounted) return;
        setState(() {
          upload.state = _State.done;
          upload.documentId = textOf(objectOf(result['document'])['id']);
        });
      } catch (error) {
        if (!mounted) return;
        setState(() {
          upload.state = _State.failed;
          upload.error = friendlyError(error);
        });
        // A lost session or permission fails every remaining file the same way.
        if (error is ApiException && const [401, 403].contains(error.status)) {
          break;
        }
      }
    }
    if (!mounted) return;
    // One run for exactly the documents this sheet added.
    final ids = [
      for (final upload in _uploads)
        if (upload.state == _State.done &&
            (upload.documentId?.isNotEmpty ?? false) &&
            !_runFor.contains(upload.documentId))
          upload.documentId!,
    ];
    var runFailed = false;
    if (searchable && ids.isNotEmpty) {
      try {
        final runId = await startProcessing(widget.api, documentIds: ids);
        widget.onQueued?.call(runId);
        _runFor.addAll(ids);
      } catch (error) {
        // A 409 explains itself, e.g. they are already being made searchable.
        runFailed = true;
        if (mounted) setState(() => _runError = friendlyError(error));
      }
    }
    if (!mounted) return;
    setState(() => _running = false);
    final failed = _uploads.any((upload) => upload.state == _State.failed);
    if (!failed && !runFailed && _skipped.isEmpty) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    if (_loadError != null) {
      return ErrorView(error: _loadError!, onRetry: _prepare);
    }
    if (_targets == null) return const LoadingView();
    return PopScope(
      canPop: !_running,
      child: _uploads.isEmpty && _skipped.isEmpty ? _setup() : _progress(),
    );
  }

  Widget _setup() {
    final colors = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SelectRow(
          label: 'Add to',
          value: _targetName,
          icon: _toMine
              ? Icons.person_outline_rounded
              : Icons.menu_book_outlined,
          tone: _toMine ? Tone.slate : toneFor(_target!.id),
          onTap: _choosing ? null : _pickTarget,
        ),
        if (_canRun) ...[
          const SizedBox(height: 8),
          Material(
            color: colors.subtle,
            borderRadius: BorderRadius.circular(14),
            clipBehavior: Clip.antiAlias,
            child: SheetOption(
              icon: Icons.auto_awesome_rounded,
              tone: Tone.violet,
              title: 'Make searchable right away',
              subtitle: 'Starts a run after the upload',
              onTap: () => setState(() => _searchable = !_searchable),
              trailing: Switch(
                value: _searchable,
                onChanged: (value) => setState(() => _searchable = value),
              ),
            ),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _choosing ? null : _choose,
          icon: _choosing
              ? SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: colors.onBrand,
                  ),
                )
              : const Icon(Icons.upload_rounded, size: 18),
          label: const Text('Choose files'),
        ),
      ],
    );
  }

  Widget _progress() {
    final colors = context.colors;
    final done = _uploads.where((upload) => upload.state == _State.done).length;
    final failed = _uploads.any((upload) => upload.state == _State.failed);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            _running
                ? 'Adding to $_targetName…'
                : '${countOf(done, 'file')} added to $_targetName',
            style: TextStyle(color: colors.ink2, fontSize: 14),
          ),
        ),
        Flexible(
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final upload in _uploads)
                _FileRow(
                  name: upload.file.fileName,
                  detail: switch (upload.state) {
                    _State.waiting => 'Waiting',
                    _State.sending => 'Uploading…',
                    _State.done => 'Added',
                    _State.failed => upload.error ?? 'Couldn’t be added',
                  },
                  danger: upload.state == _State.failed,
                  trailing: switch (upload.state) {
                    _State.sending => const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                    _State.done => Icon(
                      Icons.check_circle_rounded,
                      size: 20,
                      color: colors.success,
                    ),
                    _State.failed => Icon(
                      Icons.error_outline_rounded,
                      size: 20,
                      color: colors.danger,
                    ),
                    _State.waiting => const SizedBox(width: 18),
                  },
                ),
              for (final reason in _skipped)
                _FileRow(
                  name: reason.split(': ').first,
                  detail: reason.contains(': ')
                      ? reason.substring(reason.indexOf(': ') + 2)
                      : reason,
                  trailing: Icon(
                    Icons.block_rounded,
                    size: 20,
                    color: colors.ink3,
                  ),
                ),
            ],
          ),
        ),
        if (_runError != null) ...[
          const SizedBox(height: 8),
          InlineNotice(tone: StatusTone.danger, text: _runError!),
        ],
        const SizedBox(height: 14),
        if (!_running) ...[
          if (failed) ...[
            FilledButton(
              style: secondaryButtonStyle(context),
              onPressed: _run,
              child: const Text('Try again'),
            ),
            const SizedBox(height: 8),
          ],
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ],
    );
  }
}

class _FileRow extends StatelessWidget {
  const _FileRow({
    required this.name,
    required this.detail,
    required this.trailing,
    this.danger = false,
  });
  final String name, detail;
  final Widget trailing;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 7),
      child: Row(
        children: [
          FileTile(name: name, size: TileSize.small),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.ink,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  detail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: danger ? colors.danger : colors.ink3,
                    fontSize: 12.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          trailing,
        ],
      ),
    );
  }
}
