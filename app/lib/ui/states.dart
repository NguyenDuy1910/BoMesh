import 'package:flutter/material.dart';

import '../app/app_theme.dart';
import '../core/api_client.dart';

/// Loading: one centred spinner, optionally with what is loading.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.label});
  final String? label;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2.4),
          ),
          if (label != null) ...[
            const SizedBox(height: 14),
            Text(
              label!,
              style: TextStyle(color: context.colors.ink3, fontSize: 14),
            ),
          ],
        ],
      ),
    ),
  );
}

/// Nothing here yet: an icon, a sentence of why, and the one way forward.
class EmptyView extends StatelessWidget {
  const EmptyView({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.actionLabel,
    this.onAction,
  });
  final IconData icon;
  final String title;
  final String? message, actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(32, 48, 32, 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: colors.subtle,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Icon(icon, color: colors.ink3, size: 26),
            ),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (message != null) ...[
              const SizedBox(height: 6),
              Text(
                message!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: colors.ink3,
                  fontSize: 14,
                  height: 1.45,
                ),
              ),
            ],
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 18),
              FilledButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}

/// Something went wrong: what, in plain words, and Try again.
class ErrorView extends StatelessWidget {
  const ErrorView({
    super.key,
    required this.error,
    this.title = 'This could not be loaded',
    this.onRetry,
  });
  final Object error;
  final String title;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(32, 48, 32, 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: colors.dangerSoft,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Icon(
                Icons.error_outline_rounded,
                color: colors.danger,
                size: 26,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: 6),
            Text(
              friendlyError(error),
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.ink3, fontSize: 14, height: 1.45),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 18),
              FilledButton(onPressed: onRetry, child: const Text('Try again')),
            ],
          ],
        ),
      ),
    );
  }
}

/// A sentence a person can act on, from any failure.
String friendlyError(Object error) {
  if (error is ApiException) {
    if (error.status == 403) {
      return 'You don’t have permission to do this in this workspace.';
    }
    if (error.status == 404) return 'It no longer exists or was moved.';
    return error.message;
  }
  final text = error.toString();
  if (text.contains('SocketException') ||
      text.contains('ClientException') ||
      text.contains('Failed host lookup') ||
      text.contains('Connection refused')) {
    return 'Can’t reach BoMesh. Check your connection and try again.';
  }
  return text;
}

/// A short confirmation or failure message at the bottom of the screen.
void showToast(BuildContext context, String message) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// [showToast] for a failure.
void showError(BuildContext context, Object error) =>
    showToast(context, friendlyError(error));
