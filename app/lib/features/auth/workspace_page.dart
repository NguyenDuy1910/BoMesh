import 'package:flutter/material.dart';

import '../../ui/ui.dart';
import 'session.dart';

/// Membership selection happens before workspace resources are mounted.
class WorkspacePage extends StatelessWidget {
  const WorkspacePage({super.key, required this.controller, required this.onSelected});
  final SessionController controller;
  final Future<void> Function(String id) onSelected;

  @override
  Widget build(BuildContext context) {
    final session = controller.session!;
    return Scaffold(
      backgroundColor: context.colors.paper,
      appBar: AppHeader(title: 'Choose a workspace', paper: true, actions: [
        IconButton(tooltip: 'Sign out', onPressed: controller.busy ? null : controller.signOut,
          icon: const Icon(Icons.logout_rounded)),
      ]),
      body: RefreshIndicator(
        onRefresh: () async {
          try { await controller.refresh(); }
          catch (error) { if (context.mounted) showError(context, error); }
        },
        child: ListView(physics: const AlwaysScrollableScrollPhysics(), padding: kPagePadding, children: [
          Text('Signed in as ${session.email ?? session.displayName ?? 'your account'}', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 16),
          if (controller.busy) const LinearProgressIndicator(),
          if (controller.error != null) Padding(padding: const EdgeInsets.only(bottom: 12),
            child: InlineNotice(text: controller.error!, tone: StatusTone.danger)),
          if (session.workspaces.isEmpty) EmptyView(icon: Icons.apartment_outlined,
            title: 'No workspace is available', message: 'Ask your workspace admin to add ${session.email ?? 'your account'}, then pull to check again.')
          else ListGroup(children: [for (final workspace in session.workspaces) ListRow(
            leading: ToneTile(tone: toneFor(workspace.id), icon: Icons.apartment_rounded),
            title: workspace.name,
            subtitle: workspace.id == session.activeWorkspaceId ? 'Current workspace' : 'Open workspace',
            onTap: controller.busy ? null : () => onSelected(workspace.id),
          )]),
          const SizedBox(height: 14),
          Text('You can switch any time from Account. Each workspace keeps its own knowledge and chats.', style: Theme.of(context).textTheme.bodySmall),
        ]),
      ),
    );
  }
}
