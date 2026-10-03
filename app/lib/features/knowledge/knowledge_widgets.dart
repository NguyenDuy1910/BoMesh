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
    final failed =
        document.status == 'failed' || document.ingestion?.canRetry == true;
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

class IngestionProgressCard extends StatelessWidget {
  const IngestionProgressCard({super.key, required this.document});
  final KnowledgeDocument document;
  @override
  Widget build(BuildContext context) {
    final ingestion = document.ingestion;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: context.colors.subtle,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DocumentStatusBadge(document: document),
              if (ingestion != null)
                Text(
                  '${sentenceCase(ingestion.mode)} ingestion · Attempt ${ingestion.attempt}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
          ),
          if (ingestion?.isActive == true) ...[
            const SizedBox(height: 12),
            LinearProgressIndicator(
              value: ingestion!.fraction,
              semanticsLabel: ingestion.label,
            ),
          ],
          if (ingestion != null &&
              (ingestion.discovered > 0 || ingestion.indexed > 0)) ...[
            const SizedBox(height: 12),
            Text(
              '${ingestion.processed} of ${ingestion.discovered} processed · ${ingestion.indexed} indexed${ingestion.failed > 0 ? ' · ${ingestion.failed} failed' : ''}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (ingestion?.error.isNotEmpty == true) ...[
            const SizedBox(height: 12),
            Text(
              ingestion!.error,
              style: TextStyle(color: context.colors.danger),
            ),
          ],
          if (document.status == 'pending_content') ...[
            const SizedBox(height: 8),
            const Text(
              'The server is waiting for this file’s content. It is not yet available to read.',
            ),
          ],
          if (ingestion == null && document.status == 'available') ...[
            const SizedBox(height: 8),
            Text(
              document.isImage
                  ? 'Image attachments are available to the conversation, but are not indexed.'
                  : 'Content is available. Indexing is tracked separately from content availability.',
              style: Theme.of(context).textTheme.bodySmall,
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
