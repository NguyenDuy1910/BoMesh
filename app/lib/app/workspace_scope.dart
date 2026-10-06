import 'package:flutter/widgets.dart';

import '../core/api_client.dart';
import '../features/auth/session.dart';
import 'appearance.dart';

/// Which management sections this person may open. Each is governed by the
/// same permissions as its web counterpart; Manage itself appears only when
/// at least one is open.
class ManageAccess {
  const ManageAccess(this.session);
  final AuthSession session;

  bool get overview => session.can('tenant.read');

  /// Library covers reading; Manage → Knowledge is for people who organise
  /// collections or share them.
  bool get knowledge =>
      session.canAny(const ['knowledge.manage', 'collection.share']);
  bool get ingestion => session.canAny(const [
    'ingestion.read',
    'ingestion.run',
    'source.manage',
  ]);
  bool get access => session.canAny(const [
    'user.manage',
    'role.manage',
    'group.manage',
    'access.manage',
  ]);

  /// Deciding requests: resource access or connector access.
  bool get requests => session.canAny(const ['access.manage', 'source.manage']);
  bool get activity => session.can('audit.read');
  bool get settings => session.can('tenant.manage');

  bool get platform => const [
    'platform.tenant.read',
    'platform.user.read',
    'platform.audit.read',
    'platform.health.read',
  ].any(session.platformPermissions.contains);

  bool get workspace =>
      overview ||
      knowledge ||
      ingestion ||
      access ||
      requests ||
      activity ||
      settings;

  bool get any => workspace || platform;
}

/// What every signed-in screen needs: the workspace's API, who is signed in,
/// and the few app-wide actions a screen may trigger.
///
/// An [InheritedTheme], so sheets and dialogs opened on the root navigator
/// (above the shell) still see the scope of the screen that opened them.
class WorkspaceScope extends InheritedTheme {
  const WorkspaceScope({
    super.key,
    required this.api,
    required this.session,
    required this.auth,
    required this.appearance,
    required this.askAboutDocument,
    required this.waitingRequests,
    required this.refreshWaitingRequests,
    required super.child,
  });

  final ApiClient api;
  final AuthSession session;
  final SessionController auth;
  final AppearanceController appearance;

  /// Opens Ask with a new chat about one document.
  final void Function(String documentId, String title) askAboutDocument;

  /// Access requests waiting for this person's decision (the Manage badge).
  final int waitingRequests;
  final Future<void> Function() refreshWaitingRequests;

  ManageAccess get manage => ManageAccess(session);

  static WorkspaceScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<WorkspaceScope>();
    assert(scope != null, 'No WorkspaceScope above this widget.');
    return scope!;
  }

  @override
  Widget wrap(BuildContext context, Widget child) => WorkspaceScope(
    api: api,
    session: session,
    auth: auth,
    appearance: appearance,
    askAboutDocument: askAboutDocument,
    waitingRequests: waitingRequests,
    refreshWaitingRequests: refreshWaitingRequests,
    child: child,
  );

  @override
  bool updateShouldNotify(WorkspaceScope oldWidget) =>
      api != oldWidget.api ||
      session != oldWidget.session ||
      waitingRequests != oldWidget.waitingRequests;
}
