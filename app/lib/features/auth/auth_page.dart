import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/app_config.dart';
import '../../app/app_theme.dart';
import '../chat/widgets/product_mark.dart';
import 'google_login.dart';
import 'session.dart';

class AuthPage extends StatefulWidget {
  const AuthPage({super.key, required this.controller});
  final SessionController controller;
  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  final _form = GlobalKey<FormState>();
  final _identifier = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  final _username = TextEditingController();
  bool _register = false;
  bool _obscure = true;
  bool _validate = false;

  @override
  void dispose() {
    for (final value in [_identifier, _password, _name, _username]) {
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
            username: _username.text,
          )
        : await controller.signIn(_identifier.text, _password.text);
    if (success) TextInput.finishAutofillContext();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final busy = widget.controller.busy;
      final colors = context.colors;
      return Scaffold(
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final wide = constraints.maxWidth >= 920;
              final form = Center(
                child: SingleChildScrollView(
                  padding: EdgeInsets.symmetric(
                    horizontal: wide ? 56 : 24,
                    vertical: 32,
                  ),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 420),
                    child: AutofillGroup(
                      child: Form(
                        key: _form,
                        autovalidateMode: _validate
                            ? AutovalidateMode.onUserInteraction
                            : AutovalidateMode.disabled,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Row(
                              children: [
                                const ProductMark(size: 47),
                                const SizedBox(width: 12),
                                Flexible(
                                  child: Text(
                                    'BoThesis',
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleLarge
                                        ?.copyWith(fontSize: 24),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 44),
                            Text(
                              _register
                                  ? 'Your knowledge,\nconnected.'
                                  : 'Welcome back.',
                              style: Theme.of(context).textTheme.headlineLarge
                                  ?.copyWith(
                                    fontWeight: FontWeight.w700,
                                    letterSpacing: -1.3,
                                    height: 1.12,
                                  ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              _register
                                  ? 'Create your account to join your team’s workspace.'
                                  : 'Sign in to your workspace. Pick up where your thinking left off.',
                              style: Theme.of(context).textTheme.bodyLarge
                                  ?.copyWith(color: colors.textSecondary),
                            ),
                            const SizedBox(height: 28),
                            if (widget.controller.notice != null)
                              _notice(widget.controller.notice!, false),
                            if (widget.controller.error != null)
                              _notice(widget.controller.error!, true),
                            if (_register) ...[
                              TextFormField(
                                controller: _name,
                                enabled: !busy,
                                textInputAction: TextInputAction.next,
                                autofillHints: const [AutofillHints.name],
                                textCapitalization: TextCapitalization.words,
                                decoration: const InputDecoration(
                                  labelText: 'Your name',
                                  prefixIcon: Icon(Icons.person_outline),
                                ),
                                maxLength: 255,
                                buildCounter: (
                                  _, {
                                  required currentLength,
                                  required isFocused,
                                  maxLength,
                                }) => null,
                              ),
                              const SizedBox(height: 16),
                            ],
                            TextFormField(
                              controller: _identifier,
                              enabled: !busy,
                              autocorrect: false,
                              autofillHints: [
                                _register
                                    ? AutofillHints.email
                                    : AutofillHints.username,
                              ],
                              keyboardType: _register
                                  ? TextInputType.emailAddress
                                  : TextInputType.text,
                              textInputAction: TextInputAction.next,
                              decoration: InputDecoration(
                                labelText: _register
                                    ? 'Email address'
                                    : 'Email or username',
                                prefixIcon: const Icon(
                                  Icons.alternate_email_rounded,
                                ),
                              ),
                              validator: (value) {
                                if (value == null || value.trim().isEmpty) {
                                  return 'Enter your ${_register ? 'email address' : 'email or username'}.';
                                }
                                if (_register &&
                                    !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
                                        .hasMatch(value.trim())) {
                                  return 'Enter a valid email address.';
                                }
                                return null;
                              },
                            ),
                            if (_register) ...[
                              const SizedBox(height: 16),
                              TextFormField(
                                controller: _username,
                                enabled: !busy,
                                autocorrect: false,
                                textInputAction: TextInputAction.next,
                                autofillHints: const [
                                  AutofillHints.newUsername,
                                ],
                                decoration: const InputDecoration(
                                  labelText: 'Username (optional)',
                                  prefixIcon: Icon(Icons.badge_outlined),
                                ),
                                validator: (value) =>
                                    value != null &&
                                        value.trim().isNotEmpty &&
                                        (value.trim().length < 3 ||
                                            value.trim().length > 64)
                                    ? 'Use 3–64 characters.'
                                    : null,
                              ),
                            ],
                            const SizedBox(height: 16),
                            TextFormField(
                              controller: _password,
                              enabled: !busy,
                              obscureText: _obscure,
                              autocorrect: false,
                              enableSuggestions: false,
                              autofillHints: [
                                _register
                                    ? AutofillHints.newPassword
                                    : AutofillHints.password,
                              ],
                              textInputAction: TextInputAction.done,
                              onFieldSubmitted: (_) {
                                if (!busy) _submit();
                              },
                              decoration: InputDecoration(
                                labelText: 'Password',
                                prefixIcon: const Icon(
                                  Icons.lock_outline_rounded,
                                ),
                                helperText: _register
                                    ? 'At least 8 characters. Your password stays private.'
                                    : null,
                                suffixIcon: IconButton(
                                  tooltip: _obscure
                                      ? 'Show password'
                                      : 'Hide password',
                                  onPressed: () =>
                                      setState(() => _obscure = !_obscure),
                                  icon: Icon(
                                    _obscure
                                        ? Icons.visibility_outlined
                                        : Icons.visibility_off_outlined,
                                  ),
                                ),
                              ),
                              validator: (value) =>
                                  value == null || value.length < 8
                                  ? 'Use at least 8 characters.'
                                  : value.length > 128
                                  ? 'Use no more than 128 characters.'
                                  : null,
                            ),
                            const SizedBox(height: 24),
                            FilledButton(
                              onPressed: busy ? null : _submit,
                              child: busy
                                  ? const SizedBox.square(
                                      dimension: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Text(
                                          _register
                                              ? 'Create account'
                                              : 'Sign in',
                                        ),
                                        const SizedBox(width: 12),
                                        const Icon(
                                          Icons.arrow_forward_rounded,
                                          size: 18,
                                        ),
                                      ],
                                    ),
                            ),
                            if (AppConfig.googleClientId.isNotEmpty ||
                                AppConfig.googleServerClientId.isNotEmpty) ...[
                              const SizedBox(height: 16),
                              GoogleLogin(controller: widget.controller),
                            ],
                            const SizedBox(height: 12),
                            TextButton(
                              onPressed: busy
                                  ? null
                                  : () {
                                      setState(() {
                                        _register = !_register;
                                        _validate = false;
                                      });
                                      widget.controller.clearError();
                                    },
                              child: Text(
                                _register
                                    ? 'Already have an account? Sign in'
                                    : 'New to BoThesis? Create an account',
                              ),
                            ),
                            const SizedBox(height: 24),
                            Text(
                              'Private by design. Answers grounded in the sources you can access.',
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              );
              if (!wide) return form;
              return Row(
                children: [
                  Expanded(
                    child: Container(
                      margin: const EdgeInsets.all(24),
                      padding: const EdgeInsets.all(48),
                      decoration: BoxDecoration(
                        color: colors.brandSoft,
                        borderRadius: BorderRadius.circular(28),
                      ),
                      child: SingleChildScrollView(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(
                              Icons.hub_outlined,
                              size: 64,
                              color: colors.brand,
                            ),
                            const SizedBox(height: 32),
                            Text(
                              'One place for\nyour team’s\ncollective knowledge.',
                              style: Theme.of(context).textTheme.displaySmall
                                  ?.copyWith(
                                    fontWeight: FontWeight.w600,
                                    letterSpacing: -1.5,
                                  ),
                            ),
                            const SizedBox(height: 32),
                            for (final item in [
                              (
                                Icons.forum_outlined,
                                'Ask naturally',
                                'Go from a question to a grounded answer.',
                              ),
                              (
                                Icons.library_books_outlined,
                                'Stay connected',
                                'Documents and sources, in one workspace.',
                              ),
                              (
                                Icons.verified_user_outlined,
                                'Keep control',
                                'The right knowledge for the right people.',
                              ),
                            ])
                              Padding(
                                padding: const EdgeInsets.only(bottom: 24),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Icon(item.$1, color: colors.brand),
                                    const SizedBox(width: 16),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            item.$2,
                                            style: Theme.of(context)
                                                .textTheme
                                                .titleMedium,
                                          ),
                                          Text(
                                            item.$3,
                                            style: TextStyle(
                                              color: colors.textSecondary,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  Expanded(child: form),
                ],
              );
            },
          ),
        ),
      );
    },
  );

  Widget _notice(String message, bool error) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: error ? context.colors.dangerSoft : context.colors.brandSoft,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              error ? Icons.error_outline : Icons.info_outline,
              size: 20,
              color: error ? context.colors.danger : context.colors.brand,
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(message)),
          ],
        ),
      ),
    ),
  );
}
