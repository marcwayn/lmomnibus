#[cfg(feature = "ssr")]
#[tokio::main]
async fn main() {
    use axum::Router;
    use leptos::logging::log;
    use leptos::prelude::*;
    use leptos_axum::{generate_route_list, LeptosRoutes};
    use axum::http::{header::CACHE_CONTROL, HeaderValue};
    use lmo_web::app::{shell, App};
    use tower_http::compression::CompressionLayer;
    use tower_http::set_header::SetResponseHeaderLayer;

    let conf = get_configuration(None).unwrap();
    let addr = conf.leptos_options.site_addr;
    let leptos_options = conf.leptos_options;
    let routes = generate_route_list(App);

    // The WASM/JS bundle filenames carry no content hash, so a browser that
    // caches them will happily keep running an old build against freshly
    // rendered HTML — hydration then silently fails and the page goes inert.
    // `no-cache` means "revalidate before reuse", not "don't store": the
    // conditional request still 304s off Last-Modified, so this costs one
    // cheap round-trip and removes a whole class of stale-bundle bugs.
    let app = Router::new()
        .leptos_routes(&leptos_options, routes, {
            let leptos_options = leptos_options.clone();
            move || shell(leptos_options.clone())
        })
        .fallback(leptos_axum::file_and_error_handler(shell))
        .layer(SetResponseHeaderLayer::overriding(
            CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(CompressionLayer::new())
        .with_state(leptos_options);

    log!("listening on http://{}", &addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app.into_make_service())
        .await
        .unwrap();
}

#[cfg(not(feature = "ssr"))]
pub fn main() {
    // No client-side main — see lib.rs for the hydration entry point.
}
