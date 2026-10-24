package com.ts.launcher;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.Collator;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** A plain, ad-free home screen: clock, a Settings button and one grid of installed apps. */
public class HomeActivity extends Activity {

    private static final class App {
        final ComponentName component;
        final String label;
        final Drawable icon;

        App(ComponentName component, String label, Drawable icon) {
            this.component = component;
            this.label = label;
            this.icon = icon;
        }
    }

    private final List<App> apps = new ArrayList<>();
    private GridView grid;
    private Adapter adapter;
    private View selected;
    private boolean dirty = true;

    private final BroadcastReceiver packagesChanged = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            dirty = true;
            if (hasWindowFocus()) reload();
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_home);
        grid = (GridView) findViewById(R.id.grid);
        adapter = new Adapter();
        grid.setAdapter(adapter);
        grid.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                launch(apps.get(position).component);
            }
        });
        grid.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                highlight(view);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
                highlight(null);
            }
        });
        grid.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View v, boolean hasFocus) {
                highlight(hasFocus ? grid.getSelectedView() : null);
            }
        });
        grid.setOnKeyListener(new View.OnKeyListener() {
            @Override
            public boolean onKey(View v, int keyCode, KeyEvent event) {
                // GridView keeps Up on its top row; send it to the Settings button instead.
                if (keyCode == KeyEvent.KEYCODE_DPAD_UP && event.getAction() == KeyEvent.ACTION_DOWN
                        && grid.getSelectedItemPosition() < grid.getNumColumns()) {
                    findViewById(R.id.btnSettings).requestFocus();
                    return true;
                }
                return false;
            }
        });
        findViewById(R.id.btnSettings).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openSettings();
            }
        });

        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_REMOVED);
        filter.addAction(Intent.ACTION_PACKAGE_CHANGED);
        filter.addDataScheme("package");
        registerReceiver(packagesChanged, filter);
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(packagesChanged);
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (dirty) reload();
        grid.requestFocus();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Home pressed while already home: back to the first tile.
        if (!apps.isEmpty()) grid.setSelection(0);
        grid.requestFocus();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Back on the home screen has nowhere to go.
        if (keyCode == KeyEvent.KEYCODE_BACK) return true;
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            openSettings();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void highlight(View view) {
        if (selected != null) {
            selected.setSelected(false);
            selected.animate().scaleX(1f).scaleY(1f).setDuration(120).start();
        }
        selected = view;
        if (view != null && grid.hasFocus()) {
            view.setSelected(true);
            view.animate().scaleX(1.08f).scaleY(1.08f).setDuration(120).start();
        }
    }

    private void reload() {
        dirty = false;
        PackageManager pm = getPackageManager();
        Set<String> hidden = new HashSet<>(Arrays.asList(getResources().getStringArray(R.array.hidden_apps)));
        List<String> pinned = Arrays.asList(getResources().getStringArray(R.array.pinned_apps));

        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> found = pm.queryIntentActivities(main, 0);
        List<App> top = new ArrayList<>();
        List<App> rest = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (ResolveInfo ri : found) {
            String pkg = ri.activityInfo.packageName;
            if (hidden.contains(pkg) || !seen.add(pkg)) continue;
            App app = new App(new ComponentName(pkg, ri.activityInfo.name),
                    ri.loadLabel(pm).toString().trim(), ri.loadIcon(pm));
            (pinned.contains(pkg) ? top : rest).add(app);
        }
        final List<String> order = pinned;
        Collections.sort(top, (a, b) -> order.indexOf(a.component.getPackageName())
                - order.indexOf(b.component.getPackageName()));
        final Collator collator = Collator.getInstance(Locale.CHINA);
        Collections.sort(rest, (a, b) -> collator.compare(a.label, b.label));

        apps.clear();
        apps.addAll(top);
        apps.addAll(rest);
        adapter.notifyDataSetChanged();
    }

    private void launch(ComponentName component) {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(component)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try {
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show();
        }
    }

    private void openSettings() {
        Intent mi = new Intent().setComponent(new ComponentName(
                "com.xiaomi.mitv.settings", "com.xiaomi.mitv.settings.entry.MainActivity"));
        Intent[] candidates = {
                mi,
                getPackageManager().getLaunchIntentForPackage("com.xiaomi.mitv.settings"),
                new Intent(android.provider.Settings.ACTION_SETTINGS),
        };
        for (Intent intent : candidates) {
            if (intent == null || intent.resolveActivity(getPackageManager()) == null) continue;
            try {
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            } catch (Exception ignored) {
                // try the next one
            }
        }
        Toast.makeText(this, R.string.cannot_open, Toast.LENGTH_SHORT).show();
    }

    private final class Adapter extends BaseAdapter {
        @Override
        public int getCount() {
            return apps.size();
        }

        @Override
        public Object getItem(int position) {
            return apps.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View view, ViewGroup parent) {
            if (view == null) {
                view = LayoutInflater.from(HomeActivity.this).inflate(R.layout.item_app, parent, false);
            }
            App app = apps.get(position);
            ((ImageView) view.findViewById(R.id.icon)).setImageDrawable(app.icon);
            ((TextView) view.findViewById(R.id.label)).setText(app.label);
            return view;
        }
    }
}
