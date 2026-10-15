import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/** Test-only invocation of the unchanged APK's credential owners on a fresh AVD. */
public final class OpenClawNativeCredentialFixture {
  public static void main(String[] args) throws Exception {
    if (android.os.Looper.myLooper() == null) android.os.Looper.prepareMainLooper();
    Class.forName("android.security.keystore2.AndroidKeyStoreProvider").getMethod("install").invoke(null);
    Class<?> activityThread = Class.forName("android.app.ActivityThread");
    Object thread = activityThread.getMethod("systemMain").invoke(null);
    Context system = (Context) activityThread.getMethod("getSystemContext").invoke(thread);
    Context packageContext = system.createPackageContext("ai.openclaw.app.debug", Context.CONTEXT_INCLUDE_CODE | Context.CONTEXT_IGNORE_SECURITY);
    Context context = new ContextWrapper(packageContext) {
      @Override public Context getApplicationContext() { return this; }
    };
    ClassLoader loader = context.getClassLoader();
    Thread.currentThread().setContextClassLoader(loader);
    Class<?> identityOwner = loader.loadClass("ai.openclaw.app.gateway.DeviceIdentityStore");
    Object identity = identityOwner.getMethod("loadOrCreate").invoke(identityOwner.getConstructor(Context.class).newInstance(context));
    String deviceId = (String) identity.getClass().getMethod("getDeviceId").invoke(identity);
    File directory = new File(context.getFilesDir(), "qa-native-fixture");
    if (!directory.exists() && !directory.mkdir()) throw new IllegalStateException("fixture directory creation refused");
    if (args.length == 1 && args[0].equals("export")) {
      JSONObject exported = new JSONObject();
      exported.put("deviceId", deviceId);
      exported.put("publicKeyRawBase64", identity.getClass().getMethod("getPublicKeyRawBase64").invoke(identity));
      exported.put("privateKeyPkcs8Base64", identity.getClass().getMethod("getPrivateKeyPkcs8Base64").invoke(identity));
      File file = new File(directory, "identity.private.json");
      try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(exported.toString().getBytes(StandardCharsets.UTF_8)); }
      file.setReadable(false, false); file.setWritable(false, false); file.setReadable(true, true); file.setWritable(true, true);
      System.out.println("Synthetic Android identity exported to app-private fixture file");
    } else if (args.length == 1 && args[0].equals("save")) {
      JSONObject grant = new JSONObject(new String(Files.readAllBytes(new File(directory, "grant.private.json").toPath()), StandardCharsets.UTF_8));
      if (!deviceId.equals(grant.getString("deviceId"))) throw new IllegalStateException("scoped grant belongs to another device");
      List<String> scopes = new ArrayList<>(); JSONArray values = grant.getJSONArray("scopes");
      for (int i=0; i<values.length(); i++) scopes.add(values.getString(i));
      Class<?> prefsType = loader.loadClass("ai.openclaw.app.SecurePrefs");
      Object prefs = prefsType.getConstructor(Context.class, SharedPreferences.class).newInstance(context, null);
      Class<?> ownerType = loader.loadClass("ai.openclaw.app.gateway.DeviceAuthStore");
      Object owner = ownerType.getConstructor(prefsType).newInstance(prefs);
      Method save = ownerType.getMethod("saveToken", String.class, String.class, String.class, String.class, List.class, String.class);
      boolean stored = (Boolean) save.invoke(owner, grant.getString("gatewayId"), deviceId, "operator", grant.getString("token"), scopes, null);
      if (!stored) throw new IllegalStateException("native DeviceAuthStore refused scoped grant");
      Object before = prefsType.getMethod("loadGatewayCredentials", String.class).invoke(prefs, grant.getString("gatewayId"));
      System.out.println("Bootstrap shared-token present before clear=" + (before.getClass().getMethod("getToken").invoke(before) != null));
      prefsType.getMethod("clearGatewayCredentials", String.class).invoke(prefs, grant.getString("gatewayId"));
      Thread.sleep(1500);
      Object after = prefsType.getMethod("loadGatewayCredentials", String.class).invoke(prefs, grant.getString("gatewayId"));
      if (after.getClass().getMethod("getToken").invoke(after) != null) throw new IllegalStateException("QA bootstrap token still present");
      Object entry = ownerType.getMethod("loadEntry", String.class, String.class, String.class).invoke(owner, grant.getString("gatewayId"), deviceId, "operator");
      System.out.println("Native stored operator scopes=" + entry.getClass().getMethod("getScopes").invoke(entry));
      System.out.println("Native DeviceAuthStore committed synthetic operator grant; scopes=" + scopes);
    } else if (args.length == 1 && args[0].equals("configure")) {
      Class<?> prefsType = loader.loadClass("ai.openclaw.app.SecurePrefs");
      Object prefs = prefsType.getConstructor(Context.class, SharedPreferences.class).newInstance(context, null);
      prefsType.getMethod("setManualHost", String.class).invoke(prefs, "[QA_HOST]");
      prefsType.getMethod("setManualPort", int.class).invoke(prefs, 18945);
      prefsType.getMethod("setManualTls", boolean.class).invoke(prefs, false);
      prefsType.getMethod("setManualEnabled", boolean.class).invoke(prefs, true);
      prefsType.getMethod("setOnboardingCompleted", boolean.class).invoke(prefs, true);
      System.out.println("Native SecurePrefs committed task QA endpoint setup");
    } else throw new IllegalArgumentException("export, save or configure required");
    System.exit(0);
  }
}
