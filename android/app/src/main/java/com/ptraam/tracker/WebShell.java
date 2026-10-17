package com.ptraam.tracker;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.net.*;
import android.net.http.SslError;
import android.os.*;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.security.*;
import java.util.concurrent.*;

/** Main-frame MessagePort only. No JavascriptInterface, bearer-token injection or credential URLs. */
final class WebShell {
    interface Actions { void start(String note); void stop(); void cancelStart(); }
    private final Activity activity; private final Actions actions;
    final LinearLayout view; private final TextView notice; private final WebView web;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final String origin; private WebMessagePort port; private int generation;
    private String verifier; private boolean authenticated,ready,closed,authBusy;
    private byte[] exportBytes;
    private GeolocationPermissions.Callback locationCallback; private String locationOrigin;
    private String permissionRequest; private int permissionPage; private int offeringPage=-1;
    static final int EXPORT=310;
    WebShell(Activity activity, Actions actions){
        this.activity=activity;this.actions=actions;origin=BuildConfig.API_ORIGIN;
        view=new LinearLayout(activity);view.setOrientation(LinearLayout.VERTICAL);
        notice=new TextView(activity);notice.setTextColor(0xff274f89);notice.setBackgroundColor(0xfffff6db);notice.setPadding(16,8,16,8);view.addView(notice);
        web=new WebView(activity);view.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString()+" FieldoraAndroid/1");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onGeolocationPermissionsShowPrompt(String requestOrigin,GeolocationPermissions.Callback callback){
                // Trips use native capture. Web attendance requests are explicitly authorized by Android permissions.
                if(!ready||!authenticated||!Session.current(activity)||!trusted(web.getUrl())||!sameOrigin(origin,requestOrigin)){callback.invoke(requestOrigin,false,false);return;}
                if(activity.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)==android.content.pm.PackageManager.PERMISSION_GRANTED){callback.invoke(requestOrigin,true,false);return;}
                if(locationCallback!=null)locationCallback.invoke(locationOrigin,false,false);
                locationCallback=callback;locationOrigin=requestOrigin;
                activity.requestPermissions(new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION,android.Manifest.permission.ACCESS_COARSE_LOCATION},311);
            }
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request){
                if(!request.isForMainFrame())return !trusted(request.getUrl().toString());
                if(trusted(request.getUrl().toString()))return false;
                String scheme=request.getUrl().getScheme();
                if("https".equals(scheme)||"tel".equals(scheme))try{activity.startActivity(new Intent("tel".equals(scheme)?Intent.ACTION_DIAL:Intent.ACTION_VIEW,request.getUrl()));}catch(ActivityNotFoundException ignored){}
                return true;
            }
            @Override public void onPageStarted(WebView v,String url,Bitmap icon){
                boolean wasAuthenticated=authenticated;invalidate();actions.cancelStart();
                if(!trusted(url)){v.stopLoading();notice("Blocked navigation outside the approved staging service.");return;}
                if("/login".equals(Uri.parse(url).getPath())&&wasAuthenticated)localLogout();
                notice("Loading Fieldora?");
            }
            @Override public void onPageFinished(WebView v,String url){
                if(!trusted(url)||closed)return;
                offerPort(generation,0);
                notice("/login".equals(Uri.parse(url).getPath())?"Sign in with your Fieldora account.":"Native integration is not connected yet. This server must include the approved Android integration before trips can start.");
            }
            @Override public void onReceivedSslError(WebView v,SslErrorHandler handler,SslError error){handler.cancel();notice("Secure connection failed. No exception is allowed.");}
            @Override public void onReceivedError(WebView v,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())notice("Page unavailable. Existing native trip data remains stored. Reconnect and reopen Fieldora.");}
            @Override public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail detail){invalidate();v.destroy();activity.recreate();return true;}
        });
        if(origin.isEmpty()||!origin.equals(Backend.origin(activity)))notice("This staging build cannot change the server of an existing installation. Reconcile pending records on the original server first.");
        else web.loadUrl(origin+"/dashboard");
    }
    private void offerPort(int page,int attempt){
        if(attempt==0&&offeringPage==page)return;offeringPage=page;
        if(closed||page!=generation||ready||!trusted(web.getUrl())||attempt>=60){if(offeringPage==page)offeringPage=-1;return;}
        if(port!=null)port.close();WebMessagePort[] channel=web.createWebMessageChannel();port=channel[0];
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback(){@Override public void onMessage(WebMessagePort source,WebMessage message){if(page==generation&&source==port&&trusted(web.getUrl()))receive(message.getData(),page);}});
        web.postWebMessage(new WebMessage("fieldora-native-v1",new WebMessagePort[]{channel[1]}),Uri.parse(origin));
        web.postDelayed(()->offerPort(page,attempt+1),500);
    }
    void resume(){if(!ready&&!closed&&trusted(web.getUrl()))offerPort(generation,0);}
    private boolean locationAllowed(){return ready&&authenticated&&Session.current(activity)&&trusted(web.getUrl())&&activity.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)==android.content.pm.PackageManager.PERMISSION_GRANTED;}
    void permissionsResult(int code){
        if(code!=311)return;boolean allowed=locationAllowed();
        if(locationCallback!=null){locationCallback.invoke(locationOrigin,allowed,false);locationCallback=null;}
        if(permissionRequest!=null){String id=permissionRequest;permissionRequest=null;reply(id,new JSONObject(),allowed?null:"Allow precise location in Android app settings, then retry.",permissionPage);}
    }
    static boolean sameOrigin(String origin,String url){return WebOrigin.matches(origin,url);}
    private boolean trusted(String url){return url!=null&&sameOrigin(origin,url)&&origin.equals(Backend.origin(activity));}
    private void notice(String text){notice.setVisibility(android.view.View.VISIBLE);notice.setText(text);}
    private void invalidate(){if(locationCallback!=null){locationCallback.invoke(locationOrigin,false,false);locationCallback=null;}permissionRequest=null;offeringPage=-1;generation++;ready=false;authenticated=false;verifier=null;if(port!=null){port.close();port=null;}}
    private static String hex(byte[] bytes){StringBuilder s=new StringBuilder();for(byte b:bytes)s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
    private void reply(String id,Object result,String error,int page){
        if(closed||page!=generation||port==null||!trusted(web.getUrl()))return;
        try{port.postMessage(new WebMessage(new JSONObject().put("id",id).put("ok",error==null).put(error==null?"result":"error",error==null?result:error).toString()));}catch(Exception ignored){}
    }
    private void receive(String raw,int page){
        String id="";
        try{
            if(raw==null||raw.length()>6000000)throw new Exception("Request too large");
            JSONObject request=new JSONObject(raw);id=request.getString("id");if(!id.matches("[0-9]{1,12}"))return;
            String command=request.getString("command");
            if(!command.equals("export")&&raw.length()>2048)throw new Exception("Request too large");
            if(command.equals("hello")){if(request.optInt("version")!=1)throw new Exception("Unsupported integration version");ready=true;reply(id,new JSONObject().put("version",1).put("locationPermission",true),null,page);return;}
            if(!ready)throw new Exception("Native integration is not ready");
            if(command.equals("challenge")){
                if(authBusy)throw new Exception("Sign-in is already in progress");
                byte[] random=new byte[32];new SecureRandom().nextBytes(random);verifier=hex(random);
                reply(id,new JSONObject().put("challenge",hex(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(java.nio.charset.StandardCharsets.UTF_8)))),null,page);return;
            }
            if(command.equals("authenticate")){authenticate(id,request.getString("code"),page);return;}
            if(command.equals("back")){reply(id,new JSONObject(),null,page);if(web.canGoBack())web.goBack();else activity.moveTaskToBack(true);return;}
            if(command.equals("logout")){localLogout();reply(id,new JSONObject(),null,page);return;}
            if(!authenticated||!Session.current(activity))throw new Exception("Reconnect your Fieldora sign-in before using native actions");
            if(command.equals("start")){String note=request.optString("note","");if(note.length()>500)throw new Exception("Purpose must be at most 500 characters");actions.start(note);reply(id,new JSONObject().put("requested",true),null,page);}
            else if(command.equals("stop")){String trip=TripService.liveTrip();if(trip==null||!trip.equals(request.optString("tripId")))throw new Exception("This trip is not recording in this native session. Reconnect and reconcile its original session first.");actions.stop();reply(id,new JSONObject().put("requested",true),null,page);}
            else if(command.equals("locationPermission")){
                if(locationAllowed()){reply(id,new JSONObject(),null,page);return;}
                if(permissionRequest!=null||locationCallback!=null)throw new Exception("Finish the current location permission request first");
                permissionRequest=id;permissionPage=page;
                activity.requestPermissions(new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION,android.Manifest.permission.ACCESS_COARSE_LOCATION},311);
            }
            else if(command.equals("permissions")){activity.requestPermissions(Build.VERSION.SDK_INT>=33?new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION,android.Manifest.permission.ACCESS_COARSE_LOCATION,android.Manifest.permission.POST_NOTIFICATIONS}:new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION,android.Manifest.permission.ACCESS_COARSE_LOCATION},10);reply(id,new JSONObject(),null,page);}
            else if(command.equals("status")){reply(id,state(),null,page);}
            else if(command.equals("export")){
                if(exportBytes!=null)throw new Exception("Finish the pending export first");
                byte[] bytes=android.util.Base64.decode(request.getString("base64"),android.util.Base64.DEFAULT);if(bytes.length>4000000)throw new Exception("Export exceeds 4 MB; use the web dashboard");exportBytes=bytes;
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"Fieldora-records.xlsx");
                activity.startActivityForResult(intent,EXPORT);reply(id,new JSONObject().put("requested",true),null,page);
            } else throw new Exception("Unsupported native command");
        }catch(Exception e){reply(id,null,e.getMessage()==null?"Native operation failed":e.getMessage(),page);}
    }
    private void authenticate(String id,String code,int page)throws Exception{
        if(authBusy||verifier==null||!code.matches("[a-f0-9]{64}"))throw new Exception("Native handoff is missing or invalid");
        final String proof=verifier;verifier=null;authBusy=true;final String previous=Session.account(activity);
        worker.execute(()->{
            try{
                String token=Session.current(activity)?Session.token(activity):null;
                JSONObject result=Api.postToOrigin(origin,"/session/web",new JSONObject().put("code",code).put("verifier",proof),token);
                String account=result.getString("accountId");
                if(!previous.isEmpty()&&!previous.equals(account)){
                    TripService.stop(activity,"account_changed");
                    try(Queue queue=new Queue(activity)){if(queue.pending(previous)||!activity.getSharedPreferences("start-requests",0).getAll().isEmpty())throw new Exception("Previous account has pending trip records. Sign back into that account and reconcile them first.");}
                }
                activity.runOnUiThread(()->{
                    authBusy=false;if(closed||page!=generation||!previous.equals(Session.account(activity)))return;
                    try{Session.save(activity,account,result.getString("accessToken"),result.getLong("expiresAt"),result.optString("name"),result.optString("role"),result.optString("department"));authenticated=true;notice.setVisibility(android.view.View.GONE);SyncJob.schedule(activity);reply(id,new JSONObject().put("accountId",account),null,page);}
                    catch(Exception e){reply(id,null,"Unable to secure the native session.",page);}
                });
            }catch(Exception e){activity.runOnUiThread(()->{authBusy=false;authenticated=false;reply(id,null,e.getMessage()==null?"Native sign-in unavailable":e.getMessage(),page);});}
        });
    }
    private JSONObject state()throws Exception{return new JSONObject().put("accountId",Session.account(activity)).put("active",TripService.running!=null).put("ending",TripService.running!=null&&TripService.running.isEnding()).put("tripId",TripService.liveTrip()==null?"":TripService.liveTrip()).put("message",activity.getSharedPreferences("tracking-state",0).getString("endStatus","")).put("sync",activity.getSharedPreferences("tracking-state",0).getString("sync",""));}
    void publish(String message,String sync){if(!authenticated||port==null||!trusted(web.getUrl()))return;try{JSONObject s=state().put("message",message).put("sync",sync);port.postMessage(new WebMessage(new JSONObject().put("event","state").put("state",s).toString()));}catch(Exception ignored){}}
    void login(){web.loadUrl(origin+"/login");}
    void back(){if(ready)web.evaluateJavascript("window.dispatchEvent(new Event('fieldora-android-back'))",null);else if(web.canGoBack())web.goBack();else activity.moveTaskToBack(true);}
    void localLogout(){
        actions.cancelStart();TripService.stop(activity,"logout");authenticated=false;final String oldOrigin=Backend.origin(activity);
        try{final String token=Session.token(activity);worker.execute(()->{try{Api.postToOrigin(oldOrigin,"/session/logout",new JSONObject(),token);}catch(Exception ignored){}});}catch(Exception ignored){}
        Session.clear(activity);
    }
    void exportResult(int result,Intent data){byte[] bytes=exportBytes;exportBytes=null;if(result!=Activity.RESULT_OK||data==null||data.getData()==null||bytes==null)return;Uri uri=data.getData();worker.execute(()->{try(java.io.OutputStream out=activity.getContentResolver().openOutputStream(uri,"w")){if(out==null)throw new java.io.IOException();out.write(bytes);}catch(Exception e){activity.runOnUiThread(()->notice("Export could not be saved. Please retry."));}});}
    void close(){closed=true;invalidate();web.destroy();worker.shutdown();}
}
