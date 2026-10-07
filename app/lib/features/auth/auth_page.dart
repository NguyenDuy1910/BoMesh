import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/app_config.dart';
import '../../ui/ui.dart';
import 'google_login.dart';
import 'session.dart';

/// First run: one decision. The company Google account is the default way
/// in; email and password serve local accounts without competing with it.
class AuthPage extends StatefulWidget {
  const AuthPage({super.key, required this.controller});
  final SessionController controller;
  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  static const _padding = EdgeInsets.fromLTRB(24, 28, 24, 24);
  static final _email = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');

  final _form = GlobalKey<FormState>();
  final _identifier = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  bool _register = false;
  bool _obscure = true;
  bool _validate = false;

  bool get _googleConfigured =>
      AppConfig.googleClientId.isNotEmpty ||
      AppConfig.googleServerClientId.isNotEmpty;

  @override
  void dispose() {
    for (final value in [_identifier, _password, _name]) {
      value.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _validate = true);
    if (!_form.currentState!.validate()) return;
    final controller = widget.controller;
    final success = _register
        ? await controller.register(
            email: _identifier.text,
            password: _password.text,
            displayName: _name.text,
          )
        : await controller.signIn(_identifier.text, _password.text);
    if (success) TextInput.finishAutofillContext();
  }

  void _toggleMode() {
    setState(() {
      _register = !_register;
      _validate = false;
    });
    widget.controller.clearError();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) => Scaffold(
      backgroundColor: context.colors.canvas,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, viewport) => SingleChildScrollView(
            padding: _padding,
            child: Center(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: 440,
                  minHeight: math.max(
                    0,
                    viewport.maxHeight - _padding.vertical,
                  ),
                ),
                child: AutofillGroup(
                  child: Form(
                    key: _form,
                    autovalidateMode: _validate
                        ? AutovalidateMode.onUserInteraction
                        : AutovalidateMode.disabled,
                    // The intro sits at the top and the way in at the
                    // bottom; the space between collapses into scrolling
                    // when the keyboard is up.
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [_intro(context), _wayIn(context)],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  Widget _intro(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const BrandMark(size: 56, icon: Icons.hub_outlined),
        const SizedBox(height: 26),
        Text(
          _register ? 'Create your account.' : 'Your company knowledge, with sources.',
          style: text.headlineMedium?.copyWith(height: 1.12),
        ),
        const SizedBox(height: 10),
        Text(
          _register
              ? 'Your account starts with a personal workspace. Ask an admin to add your email to your team’s workspace.'
              : 'Use your work account to ask questions and trace every answer back to its sources.',
          style: text.bodyMedium?.copyWith(
            color: context.colors.ink2,
            height: 1.5,
          ),
        ),
      ],
    );
  }

  Widget _wayIn(BuildContext context) {
    final controller = widget.controller;
    final busy = controller.busy;
    final google = !_register && _googleConfigured;
    return Padding(
      padding: const EdgeInsets.only(top: 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (controller.notice != null)
            _notice(controller.notice!, StatusTone.neutral),
          if (controller.error != null)
            _notice(controller.error!, StatusTone.danger),
          if (google) ...[
            GoogleLogin(controller: controller),
            const _OrDivider(),
          ],
          if (_register) ...[
            TextFormField(
              controller: _name,
              enabled: !busy,
              textInputAction: TextInputAction.next,
              autofillHints: const [AutofillHints.name],
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Your name'),
              maxLength: 255,
              buildCounter: (
                _, {
                required currentLength,
                required isFocused,
                maxLength,
              }) => null,
            ),
            const SizedBox(height: 8),
          ],
          TextFormField(
            controller: _identifier,
            enabled: !busy,
            autocorrect: false,
            autofillHints: [
              _register ? AutofillHints.email : AutofillHints.username,
            ],
            keyboardType: _register
                ? TextInputType.emailAddress
                : TextInputType.text,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: _register ? 'Email address' : 'Email or username',
            ),
            validator: (value) {
              if (value == null || value.trim().isEmpty) {
                return 'Enter your ${_register ? 'email address' : 'email or username'}.';
              }
              if (_register && !_email.hasMatch(value.trim())) {
                return 'Enter a valid email address.';
              }
              return null;
            },
          ),
          const SizedBox(height: 8),
          TextFormField(
            controller: _password,
            enabled: !busy,
            obscureText: _obscure,
            autocorrect: false,
            enableSuggestions: false,
            autofillHints: [
              _register ? AutofillHints.newPassword : AutofillHints.password,
            ],
            textInputAction: TextInputAction.done,
            onFieldSubmitted: (_) {
              if (!busy) _submit();
            },
            decoration: InputDecoration(
              labelText: 'Password',
              helperText: _register ? 'At least 8 characters.' : null,
              suffixIcon: IconButton(
                tooltip: _obscure ? 'Show password' : 'Hide password',
                onPressed: () => setState(() => _obscure = !_obscure),
                icon: Icon(
                  _obscure
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                  size: 20,
                ),
              ),
            ),
            validator: (value) => value == null || value.length < 8
                ? 'Use at least 8 characters.'
                : value.length > 128
                ? 'Use no more than 128 characters.'
                : null,
          ),
          const SizedBox(height: 12),
          FilledButton(
            // Google leads when it is set up; otherwise this is the way in.
            style: google
                ? secondaryButtonStyle(context)
                : FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                  ),
            onPressed: busy ? null : _submit,
            child: busy
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(_register ? 'Create account' : 'Sign in'),
          ),
          const SizedBox(height: 6),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: context.colors.ink2),
            onPressed: busy ? null : _toggleMode,
            child: Text(
              _register ? 'I already have an account' : 'Create an account',
            ),
          ),
        ],
      ),
    );
  }

  Widget _notice(String message, StatusTone tone) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Semantics(
      liveRegion: true,
      child: InlineNotice(
        text: message,
        tone: tone,
        icon: tone == StatusTone.danger
            ? Icons.error_outline_rounded
            : Icons.info_outline_rounded,
      ),
    ),
  );
}

class _OrDivider extends StatelessWidget {
  const _OrDivider();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final line = Expanded(child: Divider(height: 1, color: colors.line));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Row(
        children: [
          line,
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              'or',
              style: TextStyle(color: colors.ink3, fontSize: 13),
            ),
          ),
          line,
        ],
      ),
    );
  }
}
