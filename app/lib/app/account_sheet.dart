import 'package:flutter/material.dart';

import '../features/auth/session.dart';
import '../ui/ui.dart';
import 'workspace_scope.dart';

String accountName(AuthSession session) =>
    session.displayName?.trim().isNotEmpty == true
    ? session.displayName!.trim()
    : session.email ?? 'Your account';

/// The signed-in person's avatar, at the right of every tab's first screen.
/// Opens the account sheet.
class AccountButton extends StatelessWidget {
  const AccountButton({super.key});

  @override
  Widget build(BuildContext context) {
    final scope = WorkspaceScope.of(context);
    return IconButton(
      tooltip: 'Account',
      onPressed: scope.auth.busy ? null : () => showAccountSheet(context),
      icon: PersonAvatar(
        name: accountName(scope.session),
        seed: scope.session.userId,
        size: 32,
      ),
    );
  }
}

/// Who you are, which workspace you are in, how the app looks, and sign out.
Future<void> showAccountSheet(BuildContext context) async {
  final scope = WorkspaceScope.of(context);
  final session = scope.session;
  final action = await showAppSheet<String>(
    context,
    builder: (sheetContext) {
      final colors = sheetContext.colors;
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PersonAvatar(
            name: accountName(session),
            seed: session.userId,
            size: 56,
          ),
          const SizedBox(height: 8),
          Text(
            accountName(session),
            textAlign: TextAlign.center,
            style: Theme.of(sheetContext).textTheme.titleLarge,
          ),
          if (session.email != null && session.email != accountName(session))
            Text(
              session.email!,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.ink3, fontSize: 13.5),
            ),
          const SizedBox(height: 18),
          SelectRow(
            label: 'Workspace',
            value: session.workspaceName,
            icon: Icons.apartment_rounded,
            tone: Tone.violet,
            onTap: session.workspaces.length > 1
                ? () => Navigator.pop(sheetContext, 'workspace')
                : null,
            trailing: session.workspaces.length > 1
                ? Text(
                    'Switch',
                    style: TextStyle(
                      color: colors.brandInk,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                : null,
          ),
          const SizedBox(height: 8),
          _AppearanceRow(scope: scope),
          const SizedBox(height: 8),
          SheetOption(
            icon: Icons.logout_rounded,
            title: 'Sign out',
            subtitle: 'Chats stay on this phone',
            danger: true,
            onTap: () => Navigator.pop(sheetContext, 'sign-out'),
          ),
        ],
      );
    },
  );
  if (!context.mounted) return;
  switch (action) {
    case 'workspace':
      await _switchWorkspace(context, scope);
    case 'sign-out':
      final confirmed = await confirmAction(
        context,
        title: 'Sign out?',
        message:
            'Your chats stay saved on this phone for when you sign in again.',
        confirmLabel: 'Sign out',
      );
      if (confirmed) await scope.auth.signOut();
  }
}

Future<void> _switchWorkspace(
  BuildContext context,
  WorkspaceScope scope,
) async {
  final session = scope.session;
  final selected = await showAppSheet<String>(
    context,
    title: 'Switch workspace',
    subtitle: 'Ask, Library and Manage follow the workspace you choose.',
    scrollable: true,
    builder: (sheetContext) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final workspace in session.workspaces)
          SheetOption(
            icon: Icons.apartment_rounded,
            tone: toneFor(workspace.id),
            title: workspace.name,
            subtitle: workspace.code.isEmpty ? null : workspace.code,
            selected: workspace.id == session.activeWorkspaceId,
            onTap: () => Navigator.pop(sheetContext, workspace.id),
          ),
      ],
    ),
  );
  if (selected == null || selected == session.activeWorkspaceId) return;
  final changed = await scope.auth.switchWorkspace(selected);
  if (!changed && context.mounted && scope.auth.error != null) {
    showToast(context, scope.auth.error!);
  }
}

class _AppearanceRow extends StatelessWidget {
  const _AppearanceRow({required this.scope});
  final WorkspaceScope scope;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return ListenableBuilder(
      listenable: scope.appearance,
      builder: (context, _) => Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
        decoration: BoxDecoration(
          color: colors.subtle,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const ToneTile(
                  tone: Tone.slate,
                  icon: Icons.dark_mode_outlined,
                  size: TileSize.small,
                ),
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Appearance',
                      style: TextStyle(color: colors.ink3, fontSize: 12.5),
                    ),
                    Text(
                      switch (scope.appearance.mode) {
                        ThemeMode.system => 'Match the phone',
                        ThemeMode.light => 'Light',
                        ThemeMode.dark => 'Dark',
                      },
                      style: TextStyle(
                        color: colors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 10),
            Segmented<ThemeMode>(
              segments: const {
                ThemeMode.system: 'Auto',
                ThemeMode.light: 'Light',
                ThemeMode.dark: 'Dark',
              },
              selected: scope.appearance.mode,
              onChanged: scope.appearance.select,
            ),
          ],
        ),
      ),
    );
  }
}
