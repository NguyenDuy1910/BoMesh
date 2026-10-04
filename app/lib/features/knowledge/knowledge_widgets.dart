import 'package:flutter/material.dart';

import '../../app/app_theme.dart';
import 'knowledge_models.dart';

class KnowledgeNotice extends StatelessWidget {
  const KnowledgeNotice({
    super.key,
    required this.title,
    this.message,
    this.icon = Icons.info_outline,
    this.actionLabel,
    this.onAction,
    this.danger = false,
  });
  final String title;
  final String? message, actionLabel;
  final IconData icon;
  final VoidCallback? onAction;
  final bool danger;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: danger ? context.colors.dangerSoft : context.colors.surface,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: context.colors.border),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          icon,
          color: danger ? context.colors.danger : context.colors.brand,
        ),
        const SizedBox(height: 12),
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        if (message?.isNotEmpty == true) ...[
          const SizedBox(height: 8),
          Text(
            message!,
            style: TextStyle(color: context.colors.textSecondary, height: 1.5),
          ),
        ],
        if (onAction != null) ...[
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: onAction,
            child: Text(actionLabel ?? 'Retry'),
          ),
        ],
      ],
    ),
  );
}

class DocumentStatusBadge extends StatelessWidget {
  const DocumentStatusBadge({super.key, required this.document});
  final KnowledgeDocument document;
  @override
  Widget build(BuildContext context) {
    final failed = document.isFailed;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: failed ? context.colors.dangerSoft : context.colors.subtle,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        document.statusLabel,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
          color: failed ? context.colors.danger : context.colors.textSecondary,
        ),
      ),
    );
  }
}

/// A document's processing state, its error when processing failed, and what
/// the state means for asking about it.
class ProcessingCard extends StatelessWidget {
  const ProcessingCard({super.key, required this.document});
  final KnowledgeDocument document;
  @override
  Widget build(BuildContext context) {
    final processing = document.processing;
    final explanation = document.status == 'pending_content'
        ? 'The server is waiting for this file’s content. It is not yet available to read.'
        : document.status == 'failed'
        ? 'The file’s content could not be stored. Upload it again.'
        : switch (processing.state) {
            'pending' => 'Added, not processed yet. It can be searched once it is processed.',
            'processing' => 'Being processed. It can be searched when this finishes.',
            'ready' => 'Processed and searchable.',
            'failed' => 'Processing did not finish. Try again from the library.',
            'outdated' => 'Searchable, but processed with older settings. Process it again to update it.',
            _ => document.isImage
                ? 'Images are available to the conversation, but are not processed.'
                : 'This file type is kept but not processed.',
          };
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: context.colors.subtle,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DocumentStatusBadge(document: document),
          if (processing.isProcessing) ...[
            const SizedBox(height: 12),
            LinearProgressIndicator(semanticsLabel: processing.label),
          ],
          const SizedBox(height: 8),
          Text(explanation, style: Theme.of(context).textTheme.bodySmall),
          if (processing.isFailed && processing.error.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              processing.error,
              style: TextStyle(color: context.colors.danger),
            ),
          ],
        ],
      ),
    );
  }
}

Future<bool> confirmKnowledgeAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: context.colors.danger,
              foregroundColor: context.colors.surface,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    ) ??
    false;
