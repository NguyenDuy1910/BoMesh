import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import '../../core/api_client.dart';
import '../../core/uploads.dart';
import 'knowledge_models.dart';

/// What an upload left behind: whether anything was added, and the run
/// started for exactly those documents when the person chose "Process now".
typedef UploadOutcome = ({bool added, String? runId});

/// Add files to [collection] in one step: the system picker opens at once and
/// what was chosen uploads straight away. Uploading only stores the files as
/// pending documents; when [canProcess] (the person holds `ingestion.run` on
/// the collection) the sheet then offers to process exactly those documents.
///
/// Archives expand into documents only inside a workspace collection, so they
/// are offered only there.
Future<UploadOutcome> uploadDocuments(
  BuildContext context, {
  required ApiClient api,
  required KnowledgeCollection collection,
  required bool personal,
  required bool canProcess,
}) async {
  const nothing = (added: false, runId: null);
  final PickedUploads picked;
  try {
    picked = await pickUploads(
      extensions: {...knowledgeExtensions, if (!personal) 'zip'},
    );
  } catch (error) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Files could not be opened: $error')),
      );
    }
    return nothing;
  }
  if (!context.mounted || picked.isEmpty) return nothing;
  if (picked.accepted.isEmpty) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(picked.rejected.join('\n'))));
    return nothing;
  }
  final outcome = await showModalBottomSheet<UploadOutcome>(
    context: context,
    useSafeArea: true,
    isDismissible: false,
    enableDrag: false,
    builder: (_) => _UploadSheet(
      api: api,
      collection: collection,
      destination: personal ? 'My files' : collection.title,
      files: picked.accepted,
      skipped: picked.rejected,
      canProcess: canProcess,
    ),
  );
  return outcome ?? nothing;
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
    required this.collection,
    required this.destination,
    required this.files,
    required this.skipped,
    required this.canProcess,
  });
  final ApiClient api;
  final KnowledgeCollection collection;

  /// What the person calls this place: "My files", or the collection's name.
  final String destination;
  final List<UploadSource> files;
  final List<String> skipped;
  final bool canProcess;
  @override
  State<_UploadSheet> createState() => _UploadSheetState();
}

class _UploadSheetState extends State<_UploadSheet> {
  late final List<_Upload> _uploads = [
    for (final file in widget.files) _Upload(file),
  ];
  bool _running = false, _starting = false;
  String? _processError;

  int get _done => _uploads.where((upload) => upload.state == _State.done).length;
  bool get _anyFailed => _uploads.any((upload) => upload.state == _State.failed);

  @override
  void initState() {
    super.initState();
    unawaited(_run());
  }

  Future<void> _run() async {
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
          '/collections/${Uri.encodeComponent(widget.collection.id)}/documents',
          file: upload.file,
          fields: const {'purpose': 'knowledge'},
          idempotencyKey: upload.key,
        );
        if (!mounted) return;
        setState(() {
          upload.state = _State.done;
          upload.documentId = textOf(objectOf(result['document'])['id']);
        });
      } catch (error) {
        if (!mounted) return;
        setState(() {
          upload.state = _State.failed;
          upload.error = error.toString();
        });
        // A lost session or permission fails every remaining file the same way.
        if (error is ApiException && const [401, 403].contains(error.status)) break;
      }
    }
    if (!mounted) return;
    setState(() => _running = false);
  }

  /// One run for exactly the documents this sheet added.
  Future<void> _processNow() async {
    final ids = [
      for (final upload in _uploads)
        if (upload.state == _State.done && upload.documentId?.isNotEmpty == true)
          upload.documentId!,
    ];
    setState(() {
      _starting = true;
      _processError = null;
    });
    try {
      final run = await startProcessing(widget.api, documentIds: ids);
      if (mounted) Navigator.pop(context, (added: true, runId: run));
    } catch (error) {
      // A 409 explains itself, e.g. the documents are already being processed.
      if (!mounted) return;
      setState(() {
        _starting = false;
        _processError = error.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _running
                  ? 'Uploading to ${widget.destination}'
                  : _anyFailed
                  ? '$_done of ${_uploads.length} added'
                  : _done == 1
                  ? '1 file added to ${widget.destination}'
                  : '$_done files added to ${widget.destination}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              widget.canProcess
                  ? 'Process them to make them searchable.'
                  : 'They become searchable once someone with processing access processes them.',
              style: TextStyle(color: colors.textSecondary),
            ),
            if (_processError != null) ...[
              const SizedBox(height: 8),
              Text(_processError!, style: TextStyle(color: colors.danger)),
            ],
            const SizedBox(height: 12),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final upload in _uploads)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: switch (upload.state) {
                        _State.sending => const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        _State.done => Icon(Icons.check_circle_rounded, color: colors.brand),
                        _State.failed => Icon(Icons.error_outline_rounded, color: colors.danger),
                        _State.waiting => Icon(Icons.schedule_rounded, color: colors.textMuted),
                      },
                      title: Text(
                        upload.file.fileName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: upload.error == null
                          ? null
                          : Text(
                              upload.error!,
                              style: TextStyle(color: colors.danger),
                            ),
                    ),
                  for (final reason in widget.skipped)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(Icons.block_rounded, color: colors.textMuted),
                      title: Text(reason, style: TextStyle(color: colors.textSecondary)),
                    ),
                ],
              ),
            ),
            if (!_running)
              SizedBox(
                width: double.infinity,
                child: Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  children: [
                    if (_anyFailed)
                      TextButton(
                        onPressed: _starting ? null : _run,
                        child: const Text('Retry failed'),
                      ),
                    if (widget.canProcess && _done > 0) ...[
                      TextButton(
                        onPressed: _starting
                            ? null
                            : () => Navigator.pop(context, (added: true, runId: null)),
                        child: const Text('Done'),
                      ),
                      FilledButton(
                        onPressed: _starting ? null : _processNow,
                        child: _starting
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Text('Process now'),
                      ),
                    ] else
                      FilledButton(
                        onPressed: () => Navigator.pop(context, (added: _done > 0, runId: null)),
                        child: const Text('Done'),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
