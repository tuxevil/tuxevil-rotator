# Auto model discovery

The proxy accepted model:auto but omitted it from /v1/models. This prevented clients that discover models through that endpoint from offering the selector.

The OpenAI-compatible catalog now includes one auto entry when semantic routing is enabled and backing models exist. Its advertised context is the minimum backing-model context; tool and image support reflect available catalog capabilities. Actual request selection still validates permissions and capabilities. Disabled routing and empty backing catalogs do not advertise auto.

Production verification after systemd restart returned29 models including auto (128000 context, tools and multimodal metadata). No client-side configuration or generated completion was changed. Agents using discovery need to refresh their model list; manually maintained lists may require a separate entry. The local Pi configuration inspected did not contain a rotator provider, so remote agent UI visibility was not verified.

Full checks:1374 passed,2 skipped,0 failures; lint0 errors and17 existing warnings. Regression covers enabled, disabled and empty-catalog discovery. The previous lack of auto traffic predates this discovery correction and does not establish behavior after clients refresh.
