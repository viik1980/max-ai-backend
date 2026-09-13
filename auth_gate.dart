// =================================================================
// AUTH GATE — не пускает в приложение без входа через Google
// =================================================================
// Оборачивает существующий главный экран приложения:
//
//   runApp(MaterialApp(home: AuthGate(child: MaxScreen(...))));
//
// Пока пользователь не залогинен — показывает простую кнопку входа.
// После успешного входа — показывает переданный child как обычно.
// Ничего не знает про ALLOWED_EMAILS на бэкенде: если бэкенд потом
// отклонит запрос как 403 (посторонний e-mail), это отдельная
// ошибка внутри AiService, не эта заглушка — она только про "вошёл
// ли человек через Google вообще", не про "разрешён ли ему доступ".
// =================================================================

import 'package:flutter/material.dart';
import 'max_auth.dart';

class AuthGate extends StatelessWidget {
  final Widget child;
  const AuthGate({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder(
      stream: MaxAuth.instance.authStateChanges,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(
            backgroundColor: Color(0xFF050505),
            body: Center(child: CircularProgressIndicator(color: Colors.cyanAccent)),
          );
        }

        final user = snapshot.data;
        if (user == null) {
          return const _SignInScreen();
        }

        return child;
      },
    );
  }
}

class _SignInScreen extends StatefulWidget {
  const _SignInScreen();

  @override
  State<_SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<_SignInScreen> {
  bool _loading = false;
  String? _error;

  Future<void> _handleSignIn() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await MaxAuth.instance.signInWithGoogle();
    } catch (e) {
      setState(() => _error = 'Не удалось войти: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF050505),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Дежурный Макс',
                style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 12),
              const Text(
                'Вход только для приглашённых тестеров',
                style: TextStyle(color: Colors.white54, fontSize: 14),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 32),
              if (_loading)
                const CircularProgressIndicator(color: Colors.cyanAccent)
              else
                ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black87,
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  icon: const Icon(Icons.login),
                  label: const Text('Войти через Google'),
                  onPressed: _handleSignIn,
                ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(_error!, style: const TextStyle(color: Colors.redAccent), textAlign: TextAlign.center),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
