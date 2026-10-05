import 'package:flutter/material.dart';

import '../../ui/ui.dart';

/// "Continue with Google": the outlined, full-width way in.
Widget googleButton({required VoidCallback onPressed}) => Builder(
  builder: (context) {
    final colors = context.colors;
    return OutlinedButton.icon(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        backgroundColor: colors.canvas,
        foregroundColor: colors.ink,
        side: BorderSide(color: colors.lineStrong),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
      ),
      icon: const Icon(Icons.g_mobiledata_rounded, size: 30),
      label: const Text('Continue with Google'),
    );
  },
);
