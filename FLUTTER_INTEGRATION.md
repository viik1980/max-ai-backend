# Подключение Google Sign-In + пиннинга во Flutter-приложении

## 1. pubspec.yaml — добавить зависимости

```yaml
dependencies:
  firebase_core: ^3.6.0
  firebase_auth: ^5.3.1
  google_sign_in: ^6.2.1
  crypto: ^3.0.3
```
(версии ориентировочные — `flutter pub outdated` подскажет актуальные на момент сборки)

## 2. Подключить Firebase к проекту (если ещё не подключён как runtime SDK)

Firebase App Distribution, которым вы пользуетесь для раздачи тестерам, — это
отдельный Gradle-плагин, он НЕ означает, что в приложении уже есть Firebase SDK
для рантайма. Нужно:

```bash
dart pub global activate flutterfire_cli
flutterfire configure
```

Выбрать тот же Firebase-проект, что уже используется для App Distribution.
Команда сама положит `google-services.json` (Android) и сгенерирует
`lib/firebase_options.dart`.

## 3. Включить Google как провайдер входа

1. Firebase Console → Authentication → Sign-in method → **Google** → Enable.
2. Если раньше включал Anonymous под старый план — можно отключить, он больше
   не используется, лишний включённый провайдер — просто лишняя открытая
   дверь без надобности.

### 3.1. Обязательно — зарегистрировать SHA-1 отпечаток приложения

Без этого шага Google Sign-In на Android упадёт с ошибкой (`ApiException: 10`,
`DEVELOPER_ERROR`) — Google должен знать, что именно твоё подписанное
приложение имеет право просить вход.

Отпечаток debug-сборки (для тестирования до релиза):
```bash
cd android
./gradlew signingReport
```
В выводе найди блок `Variant: debug` → строку `SHA1: XX:XX:...`.

Для релизной сборки (та, что пойдёт в Play Console internal testing) —
свой отдельный SHA-1, от keystore, которым подписываешь релиз:
```bash
keytool -list -v -keystore путь/к/твоему.keystore -alias твой_алиас
```

Оба отпечатка (debug и release) добавь в Firebase:
Project settings → шестерёнка → вкладка **General** → секция "Your apps" →
Android-приложение → **Add fingerprint** → вставить SHA-1 → Save.
Перезалить свежий `google-services.json` из этого же места после добавления —
он должен знать про оба отпечатка.

## 4. main.dart — инициализация и AuthGate

```dart
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';
import 'auth_gate.dart'; // новый файл

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  runApp(const MyApp());
}

// внутри MyApp, там где раньше было home: MaxScreen(...):
home: AuthGate(child: MaxScreen(...)),
```

Пока пользователь не вошёл — увидит кнопку "Войти через Google" вместо
главного экрана (см. `auth_gate.dart`). После входа — обычный интерфейс,
как было. Если бэкенд потом отклонит его как постороннего (403, e-mail не
в `ALLOWED_EMAILS`) — это уже не про AuthGate, это ошибка внутри AiService
при обращении к бэкенду, отдельная история.

## 5. Получить пины сертификата Railway-бэкенда

Замени `<твой-домен>` на реальный домен из Railway (Settings → Networking):

```bash
# Листовой сертификат (основной пин) — SHA-256
openssl s_client -connect <твой-домен>:443 -servername <твой-домен> </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'

# Промежуточный сертификат Let's Encrypt (backup-пин) — SHA-256
openssl s_client -connect <твой-домен>:443 -servername <твой-домен> -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN/{i++}i==2' \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'
```

Получишь два hex-отпечатка — оба идут в один `--dart-define` через запятую.

## 6. Команда сборки

```bash
flutter build apk --release \
  --dart-define=BACKEND_BASE_URL=https://<твой-домен> \
  --dart-define=BACKEND_CERT_PINS=<отпечаток_листового>,<отпечаток_intermediate> \
  --dart-define=ENFORCE_PINNING=true
```

Если после ротации сертификата приложение вдруг перестало соединяться —
экстренный хотфикс: пересобрать с `--dart-define=ENFORCE_PINNING=false`,
без изменения кода, пока не соберёшь новые пины.

## 7. Использование в коде

`ai_service.dart` уже написан под эти файлы:
- `MaxAuth.instance.getIdToken()` — токен для заголовка `Authorization`.
  Бросает исключение, если никто не залогинен — это нормально, до
  AiService дело не доходит, пока AuthGate не пропустил дальше.
- `SecureHttpClient.instance` — клиент вместо голого `http.post`/`http.Client()`
  для запросов к своему бэкенду (НЕ для fallback-запросов к OpenAI — тот
  идёт обычным `http`, пиннинг там не нужен и не настроен).

## 8. После сборки — собрать список ALLOWED_EMAILS

Дай каждому тестеру один раз войти через Google, спроси e-mail (тот, которым
логинился), собери все — впиши в Railway → Variables → `ALLOWED_EMAILS`
через запятую. Без этого шага бэкенд пока пускает любой валидный Google-
аккаунт (см. предупреждение в логах Railway: `ALLOWED_EMAILS пуст`).
