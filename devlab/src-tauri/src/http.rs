use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    str,
    time::{Duration, Instant},
};

use crate::workspace::CommandError;

const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_HEADER_COUNT: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 64;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_REQUEST_HEADER_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 5 * 1024 * 1024;
const MIN_TIMEOUT_SECS: u64 = 10;
const DEFAULT_TIMEOUT_SECS: u64 = 15;
const MAX_TIMEOUT_SECS: u64 = 30;
const PER_ADDRESS_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpHeader {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<HttpHeader>,
    #[serde(default)]
    body: String,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    url: String,
    status: u16,
    status_text: String,
    headers: Vec<HttpHeader>,
    body: String,
    body_kind: &'static str,
    body_truncated: bool,
    bytes_received: usize,
    request_body_bytes: usize,
    elapsed_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedUrl {
    scheme: String,
    host: String,
    host_header: String,
    port: u16,
    path: String,
}

#[derive(Clone, Debug)]
struct ParsedResponseHead {
    status: u16,
    status_text: String,
    headers: Vec<HttpHeader>,
}

struct BodyReader<'a, R: Read + ?Sized> {
    stream: &'a mut R,
    buffer: Vec<u8>,
}

impl<'a, R: Read + ?Sized> BodyReader<'a, R> {
    fn new(stream: &'a mut R, buffer: Vec<u8>) -> Self {
        Self { stream, buffer }
    }

    fn read_more(&mut self) -> Result<usize, CommandError> {
        let mut chunk = [0_u8; 16 * 1024];
        let count = self
            .stream
            .read(&mut chunk)
            .map_err(|error| http_io_error("read the HTTP response", error))?;
        self.buffer.extend_from_slice(&chunk[..count]);
        Ok(count)
    }

    fn ensure(&mut self, count: usize) -> Result<(), CommandError> {
        while self.buffer.len() < count {
            if self.read_more()? == 0 {
                return Err(CommandError::new(
                    "http_protocol_error",
                    "The server closed the connection before the response body was complete.",
                ));
            }
        }
        Ok(())
    }

    fn read_line(&mut self, max_bytes: usize) -> Result<Vec<u8>, CommandError> {
        loop {
            if let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line = self.buffer.drain(..=index).collect::<Vec<u8>>();
                if line.ends_with(b"\n") {
                    line.pop();
                }
                if line.ends_with(b"\r") {
                    line.pop();
                }
                return Ok(line);
            }
            if self.buffer.len() > max_bytes {
                return Err(CommandError::new(
                    "http_protocol_error",
                    "An HTTP response line exceeded DevLab's parser limit.",
                ));
            }
            if self.read_more()? == 0 {
                return Err(CommandError::new(
                    "http_protocol_error",
                    "The server closed the connection before finishing a response line.",
                ));
            }
        }
    }

    fn take_exact(&mut self, count: usize) -> Result<Vec<u8>, CommandError> {
        self.ensure(count)?;
        Ok(self.buffer.drain(..count).collect())
    }

    fn take_up_to(&mut self, limit: usize) -> Result<(Vec<u8>, bool), CommandError> {
        let mut output = Vec::new();
        let mut truncated = false;
        loop {
            if !self.buffer.is_empty() {
                let remaining = limit.saturating_sub(output.len());
                let keep = self.buffer.len().min(remaining);
                output.extend(self.buffer.drain(..keep));
                if keep == 0 || !self.buffer.is_empty() {
                    truncated = true;
                    break;
                }
            }
            if output.len() >= limit {
                match self.read_more() {
                    Ok(0) => break,
                    Ok(_) => {
                        truncated = true;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
            if self.read_more()? == 0 {
                break;
            }
        }
        Ok((output, truncated))
    }
}

fn validate_method(method: &str) -> Result<String, CommandError> {
    let method = method.trim().to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => Ok(method),
        _ => Err(CommandError::new(
            "http_method_unsupported",
            "Use one of GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS.",
        )),
    }
}

fn validate_timeout(value: Option<u64>) -> Result<Duration, CommandError> {
    let seconds = value.unwrap_or(DEFAULT_TIMEOUT_SECS);
    if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&seconds) {
        return Err(CommandError::new(
            "http_timeout_out_of_range",
            format!("HTTP timeouts must be between {MIN_TIMEOUT_SECS} and {MAX_TIMEOUT_SECS} seconds."),
        ));
    }
    Ok(Duration::from_secs(seconds))
}

fn parse_url(input: &str) -> Result<ParsedUrl, CommandError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(CommandError::new("http_url_required", "Enter an HTTP or HTTPS URL."));
    }
    if input.len() > MAX_URL_BYTES {
        return Err(CommandError::new(
            "http_url_too_large",
            format!("URLs are limited to {} KiB.", MAX_URL_BYTES / 1024),
        ));
    }
    if input.bytes().any(|byte| byte.is_ascii_control() || byte == b' ') {
        return Err(CommandError::new(
            "http_invalid_url",
            "URLs cannot contain spaces or control characters. Percent-encode them first.",
        ));
    }
    if !input.is_ascii() {
        return Err(CommandError::new(
            "http_invalid_url",
            "This checkpoint accepts ASCII URLs. Use punycode and percent-encoding for internationalized URLs.",
        ));
    }

    let (scheme, rest) = input.split_once("://").ok_or_else(|| {
        CommandError::new("http_invalid_url", "URLs must start with http:// or https://.")
    })?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(CommandError::new(
            "http_unsupported_scheme",
            "Only http:// and https:// URLs are accepted by the native HTTP client.",
        ));
    }

    let rest_without_fragment = rest.split_once('#').map_or(rest, |(prefix, _)| prefix);
    let path_start = rest_without_fragment
        .find(|ch| ch == '/' || ch == '?')
        .unwrap_or(rest_without_fragment.len());
    let authority = &rest_without_fragment[..path_start];
    if authority.is_empty() || authority.contains('@') {
        return Err(CommandError::new(
            "http_invalid_url",
            "Enter a host name directly in the URL. Embedded credentials are not accepted.",
        ));
    }
    let path = match rest_without_fragment.get(path_start..) {
        Some("") | None => "/".to_string(),
        Some(value) if value.starts_with('?') => format!("/{value}"),
        Some(value) => value.to_string(),
    };
    if path.bytes().any(|byte| byte.is_ascii_control() || byte == b' ') {
        return Err(CommandError::new(
            "http_invalid_url",
            "URL paths cannot contain spaces or control characters. Percent-encode them first.",
        ));
    }

    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, explicit_port, host_header_base) = parse_authority(authority)?;
    let port = match explicit_port {
        Some(port) => port,
        None => default_port,
    };
    let host_header = if explicit_port.is_some() || port != default_port {
        format!("{host_header_base}:{port}")
    } else {
        host_header_base
    };

    Ok(ParsedUrl {
        scheme,
        host,
        host_header,
        port,
        path,
    })
}

fn parse_authority(authority: &str) -> Result<(String, Option<u16>, String), CommandError> {
    if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(|| {
            CommandError::new("http_invalid_url", "IPv6 hosts must be enclosed in brackets.")
        })?;
        let host = authority[1..end].to_string();
        validate_host(&host, true)?;
        let remainder = &authority[end + 1..];
        let port = if remainder.is_empty() {
            None
        } else {
            let value = remainder.strip_prefix(':').ok_or_else(|| {
                CommandError::new("http_invalid_url", "Unexpected characters after the IPv6 host.")
            })?;
            Some(parse_port(value)?)
        };
        return Ok((host, port, format!("[{}]", &authority[1..end])));
    }

    if authority.matches(':').count() > 1 {
        return Err(CommandError::new(
            "http_invalid_url",
            "IPv6 hosts must be enclosed in brackets, for example http://[::1]:8080/.",
        ));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(parse_port(port)?)),
        None => (authority, None),
    };
    validate_host(host, false)?;
    Ok((host.to_string(), port, host.to_string()))
}

fn parse_port(value: &str) -> Result<u16, CommandError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CommandError::new("http_invalid_url", "URL ports must be numeric."));
    }
    let port = value
        .parse::<u16>()
        .map_err(|_| CommandError::new("http_invalid_url", "URL ports must be between 1 and 65535."))?;
    if port == 0 {
        return Err(CommandError::new("http_invalid_url", "URL ports must be between 1 and 65535."));
    }
    Ok(port)
}

fn validate_host(host: &str, ipv6: bool) -> Result<(), CommandError> {
    if host.is_empty() || host.len() > 253 {
        return Err(CommandError::new(
            "http_invalid_url",
            "The URL host must be present and shorter than 254 bytes.",
        ));
    }
    let valid = if ipv6 {
        host.bytes()
            .all(|byte| byte.is_ascii_hexdigit() || matches!(byte, b':' | b'.'))
    } else {
        host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
        })
    };
    if !valid || host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return Err(CommandError::new(
            "http_invalid_url",
            "The URL host contains unsupported characters.",
        ));
    }
    Ok(())
}

fn validate_headers(headers: &[HttpHeader]) -> Result<Vec<HttpHeader>, CommandError> {
    if headers.len() > MAX_HEADER_COUNT {
        return Err(CommandError::new(
            "http_too_many_headers",
            format!("HTTP requests may include at most {MAX_HEADER_COUNT} custom headers."),
        ));
    }
    let mut output = Vec::with_capacity(headers.len());
    let mut total = 0_usize;
    for header in headers {
        let name = header.name.trim().to_string();
        let value = header.value.trim().to_string();
        if name.is_empty() || name.len() > MAX_HEADER_NAME_BYTES || !name.bytes().all(is_token_byte) {
            return Err(CommandError::new(
                "http_invalid_header",
                "Header names must be non-empty HTTP tokens up to 64 bytes.",
            ));
        }
        let lower = name.to_ascii_lowercase();
        if restricted_request_header(&lower) {
            return Err(CommandError::new(
                "http_restricted_header",
                format!("DevLab sets the {name} header itself for bounded native requests."),
            ));
        }
        if value.len() > MAX_HEADER_VALUE_BYTES
            || value
                .bytes()
                .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0 || (byte < 0x20 && byte != b'\t'))
        {
            return Err(CommandError::new(
                "http_invalid_header",
                "Header values cannot contain line breaks, null bytes or more than 8 KiB.",
            ));
        }
        total = total
            .saturating_add(name.len())
            .saturating_add(value.len())
            .saturating_add(4);
        if total > MAX_REQUEST_HEADER_BYTES {
            return Err(CommandError::new(
                "http_headers_too_large",
                "HTTP request headers are limited to 32 KiB.",
            ));
        }
        output.push(HttpHeader { name, value });
    }
    Ok(output)
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(byte, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
}

fn restricted_request_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "proxy-connection"
            | "keep-alive"
            | "upgrade"
            | "te"
            | "trailer"
            | "expect"
            | "accept-encoding"
    )
}

fn has_header(headers: &[HttpHeader], name: &str) -> bool {
    headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case(name))
}

fn build_request(
    method: &str,
    url: &ParsedUrl,
    headers: &[HttpHeader],
    body: &[u8],
) -> Result<Vec<u8>, CommandError> {
    let mut request = Vec::new();
    write!(request, "{method} {} HTTP/1.1\r\n", url.path)
        .map_err(|_| CommandError::new("http_request_failed", "Could not build the HTTP request."))?;
    write!(request, "Host: {}\r\n", url.host_header)
        .map_err(|_| CommandError::new("http_request_failed", "Could not build the HTTP request."))?;
    request.extend_from_slice(b"Connection: close\r\nAccept-Encoding: identity\r\n");
    if !has_header(headers, "User-Agent") {
        request.extend_from_slice(b"User-Agent: DevLab-Native-HTTP/1.11\r\n");
    }
    if !has_header(headers, "Accept") {
        request.extend_from_slice(b"Accept: */*\r\n");
    }
    for header in headers {
        write!(request, "{}: {}\r\n", header.name, header.value)
            .map_err(|_| CommandError::new("http_request_failed", "Could not build the HTTP request."))?;
    }
    if !body.is_empty() {
        write!(request, "Content-Length: {}\r\n", body.len())
            .map_err(|_| CommandError::new("http_request_failed", "Could not build the HTTP request."))?;
    }
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(body);
    if request.len() > MAX_REQUEST_HEADER_BYTES + MAX_REQUEST_BODY_BYTES + 4096 {
        return Err(CommandError::new(
            "http_request_too_large",
            "The encoded HTTP request exceeded DevLab's safety limit.",
        ));
    }
    Ok(request)
}

fn connect_stream(url: &ParsedUrl, timeout: Duration) -> Result<Box<dyn ReadWrite + Send>, CommandError> {
    let started = Instant::now();
    let addresses = (url.host.as_str(), url.port).to_socket_addrs().map_err(|error| {
        CommandError::new(
            "http_dns_failed",
            format!("Could not resolve {}: {error}", url.host),
        )
    })?;
    let mut last_error: Option<io::Error> = None;
    for address in addresses.take(8) {
        let remaining = timeout.checked_sub(started.elapsed()).ok_or_else(|| {
            CommandError::new(
                "http_timeout",
                format!("The HTTP connection exceeded the {} second timeout.", timeout.as_secs()),
            )
        })?;
        let connect_timeout = remaining.min(PER_ADDRESS_CONNECT_TIMEOUT);
        match TcpStream::connect_timeout(&address, connect_timeout) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(timeout))
                    .map_err(|error| http_io_error("configure the HTTP read timeout", error))?;
                stream
                    .set_write_timeout(Some(timeout))
                    .map_err(|error| http_io_error("configure the HTTP write timeout", error))?;
                if url.scheme == "https" {
                    let connector = TlsConnector::new().map_err(|error| {
                        CommandError::new(
                            "http_tls_failed",
                            format!("Could not initialize TLS verification: {error}"),
                        )
                    })?;
                    let tls = connector.connect(&url.host, stream).map_err(|error| match error {
                        native_tls::HandshakeError::Failure(error) => CommandError::new(
                            "http_tls_failed",
                            format!("TLS verification or handshake failed: {error}"),
                        ),
                        native_tls::HandshakeError::WouldBlock(_) => CommandError::new(
                            "http_timeout",
                            "The TLS handshake did not complete within the HTTP timeout.",
                        ),
                    })?;
                    return Ok(Box::new(tls));
                }
                return Ok(Box::new(stream));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(CommandError::new(
        "http_connection_failed",
        match last_error {
            Some(error) => format!("Could not connect to {}:{}: {error}", url.host, url.port),
            None => format!("Could not resolve any address for {}.", url.host),
        },
    ))
}

fn find_header_end(buffer: &[u8]) -> Option<(usize, usize)> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2))
        })
}

fn read_header_block<R: Read + ?Sized>(
    stream: &mut R,
    mut buffer: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>), CommandError> {
    loop {
        if let Some((index, marker_len)) = find_header_end(&buffer) {
            let body = buffer.split_off(index + marker_len);
            buffer.truncate(index);
            return Ok((buffer, body));
        }
        if buffer.len() > MAX_RESPONSE_HEADER_BYTES {
            return Err(CommandError::new(
                "http_response_headers_too_large",
                "The server returned more than 64 KiB of response headers.",
            ));
        }
        let mut chunk = [0_u8; 8 * 1024];
        let count = stream
            .read(&mut chunk)
            .map_err(|error| http_io_error("read the HTTP response headers", error))?;
        if count == 0 {
            return Err(CommandError::new(
                "http_protocol_error",
                "The server closed the connection before sending complete HTTP headers.",
            ));
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
}

fn parse_response_head(block: &[u8]) -> Result<ParsedResponseHead, CommandError> {
    let text = str::from_utf8(block).map_err(|_| {
        CommandError::new(
            "http_protocol_error",
            "The server returned response headers that are not valid UTF-8.",
        )
    })?;
    let mut lines = text.lines();
    let status_line = lines.next().ok_or_else(|| {
        CommandError::new("http_protocol_error", "The server returned an empty HTTP response.")
    })?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/") {
        return Err(CommandError::new(
            "http_protocol_error",
            "The server did not return an HTTP status line.",
        ));
    }
    let status = parts
        .next()
        .ok_or_else(|| CommandError::new("http_protocol_error", "The HTTP status code is missing."))?
        .parse::<u16>()
        .map_err(|_| CommandError::new("http_protocol_error", "The HTTP status code is invalid."))?;
    let status_text = parts.next().unwrap_or_default().trim().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| {
            CommandError::new("http_protocol_error", "A response header was missing a colon.")
        })?;
        let name = name.trim().to_string();
        let value = value.trim().to_string();
        if name.len() > MAX_HEADER_NAME_BYTES || value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(CommandError::new(
                "http_response_headers_too_large",
                "A response header exceeded DevLab's display limit.",
            ));
        }
        headers.push(HttpHeader { name, value });
        if headers.len() > MAX_HEADER_COUNT * 4 {
            return Err(CommandError::new(
                "http_response_headers_too_large",
                "The server returned too many response headers to display safely.",
            ));
        }
    }
    Ok(ParsedResponseHead {
        status,
        status_text,
        headers,
    })
}

fn header_value<'a>(headers: &'a [HttpHeader], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .rev()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn read_response_head<R: Read + ?Sized>(
    stream: &mut R,
) -> Result<(ParsedResponseHead, Vec<u8>), CommandError> {
    let mut pending = Vec::new();
    for _ in 0..5 {
        let (block, body) = read_header_block(stream, pending)?;
        let head = parse_response_head(&block)?;
        if (100..200).contains(&head.status) && head.status != 101 {
            pending = body;
            continue;
        }
        return Ok((head, body));
    }
    Err(CommandError::new(
        "http_protocol_error",
        "The server returned too many interim HTTP responses.",
    ))
}

fn read_body<R: Read + ?Sized>(
    stream: &mut R,
    initial: Vec<u8>,
    method: &str,
    response: &ParsedResponseHead,
) -> Result<(Vec<u8>, bool), CommandError> {
    if method == "HEAD" || matches!(response.status, 204 | 304) {
        return Ok((Vec::new(), false));
    }
    let mut reader = BodyReader::new(stream, initial);
    let transfer_encoding = header_value(&response.headers, "Transfer-Encoding")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if transfer_encoding
        .split(',')
        .map(|value| value.trim())
        .any(|value| value == "chunked")
    {
        return read_chunked_body(&mut reader);
    }
    if let Some(length) = header_value(&response.headers, "Content-Length") {
        let length = length.trim().parse::<usize>().map_err(|_| {
            CommandError::new("http_protocol_error", "The response Content-Length is invalid.")
        })?;
        let keep = length.min(MAX_RESPONSE_BODY_BYTES);
        let body = reader.take_exact(keep)?;
        return Ok((body, length > MAX_RESPONSE_BODY_BYTES));
    }
    reader.take_up_to(MAX_RESPONSE_BODY_BYTES)
}

fn read_chunked_body<R: Read + ?Sized>(
    reader: &mut BodyReader<'_, R>,
) -> Result<(Vec<u8>, bool), CommandError> {
    let mut output = Vec::new();
    loop {
        let line = reader.read_line(1024)?;
        let line = str::from_utf8(&line).map_err(|_| {
            CommandError::new("http_protocol_error", "A chunk-size line was not valid UTF-8.")
        })?;
        let size_text = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| {
            CommandError::new("http_protocol_error", "The response contained an invalid chunk size.")
        })?;
        if size == 0 {
            break;
        }
        if output.len().saturating_add(size) > MAX_RESPONSE_BODY_BYTES {
            let remaining = MAX_RESPONSE_BODY_BYTES.saturating_sub(output.len());
            if remaining > 0 {
                output.extend(reader.take_exact(remaining)?);
            }
            return Ok((output, true));
        }
        output.extend(reader.take_exact(size)?);
        let delimiter = reader.take_exact(2)?;
        if delimiter.as_slice() != b"\r\n" && delimiter.as_slice() != b"\n\n" {
            return Err(CommandError::new(
                "http_protocol_error",
                "A chunk was not followed by the required line break.",
            ));
        }
    }
    Ok((output, false))
}

fn text_like(headers: &[HttpHeader]) -> bool {
    let value = header_value(headers, "Content-Type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    value.is_empty()
        || value.starts_with("text/")
        || value.contains("json")
        || value.contains("xml")
        || value.contains("javascript")
        || value.contains("x-www-form-urlencoded")
}

fn render_body(bytes: &[u8], headers: &[HttpHeader], truncated: bool) -> (String, &'static str) {
    let content_encoding = header_value(headers, "Content-Encoding").unwrap_or_default();
    if !content_encoding.is_empty() && !content_encoding.eq_ignore_ascii_case("identity") {
        let mut label = format!(
            "<encoded response body · {} bytes · Content-Encoding: {}>",
            bytes.len(),
            content_encoding
        );
        if truncated {
            label.push_str("\n… response body truncated after 5 MiB.");
        }
        return (label, "binary");
    }
    if text_like(headers) {
        let mut text = String::from_utf8_lossy(bytes).into_owned();
        if truncated {
            text.push_str("\n… response body truncated after 5 MiB.");
        }
        return (text, "text");
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(mut text) if text.chars().all(|ch| ch == '\n' || ch == '\r' || ch == '\t' || !ch.is_control()) => {
            if truncated {
                text.push_str("\n… response body truncated after 5 MiB.");
            }
            (text, "text")
        }
        _ => {
            let kind = header_value(headers, "Content-Type").unwrap_or("unknown content type");
            let mut label = format!("<binary response body · {} bytes · {kind}>", bytes.len());
            if truncated {
                label.push_str("\n… response body truncated after 5 MiB.");
            }
            (label, "binary")
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn http_io_error(action: &str, error: io::Error) -> CommandError {
    if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
        CommandError::new("http_timeout", format!("Could not {action}: the operation timed out."))
    } else {
        let detail = error.to_string();
        let detail: String = detail.chars().take(2_048).collect();
        CommandError::new("http_io_error", format!("Could not {action}: {detail}"))
    }
}

fn send_request(request: HttpRequest) -> Result<HttpResponse, CommandError> {
    let started = Instant::now();
    let method = validate_method(&request.method)?;
    let timeout = validate_timeout(request.timeout_secs)?;
    let url = parse_url(&request.url)?;
    let headers = validate_headers(&request.headers)?;
    let body = request.body.into_bytes();
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(CommandError::new(
            "http_request_body_too_large",
            "HTTP request bodies are limited to 2 MiB in this checkpoint.",
        ));
    }

    let raw_request = build_request(&method, &url, &headers, &body)?;
    let mut stream = connect_stream(&url, timeout)?;
    stream
        .write_all(&raw_request)
        .and_then(|_| stream.flush())
        .map_err(|error| http_io_error("send the HTTP request", error))?;

    let (head, initial_body) = read_response_head(&mut *stream)?;
    let (body_bytes, body_truncated) = read_body(&mut *stream, initial_body, &method, &head)?;
    let bytes_received = body_bytes.len();
    let (body_text, body_kind) = render_body(&body_bytes, &head.headers, body_truncated);
    Ok(HttpResponse {
        url: request.url,
        status: head.status,
        status_text: head.status_text,
        headers: head.headers,
        body: body_text,
        body_kind,
        body_truncated,
        bytes_received,
        request_body_bytes: body.len(),
        elapsed_ms: elapsed_ms(started),
    })
}

async fn blocking<T, F>(work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            CommandError::new(
                "http_worker_failed",
                "The native HTTP worker stopped unexpectedly.",
            )
        })?
}

#[tauri::command]
pub async fn http_request(request: HttpRequest) -> Result<HttpResponse, CommandError> {
    blocking(move || send_request(request)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> HttpHeader {
        HttpHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn parses_http_and_https_urls() {
        let url = parse_url("https://example.com/api?q=1").expect("https URL should parse");
        assert_eq!(url.scheme, "https");
        assert_eq!(url.host, "example.com");
        assert_eq!(url.port, 443);
        assert_eq!(url.path, "/api?q=1");
        assert_eq!(url.host_header, "example.com");

        let local = parse_url("http://127.0.0.1:8080/").expect("local URL should parse");
        assert_eq!(local.port, 8080);
        assert_eq!(local.host_header, "127.0.0.1:8080");
    }

    #[test]
    fn rejects_unsupported_urls() {
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("https://user:pass@example.com/").is_err());
        assert!(parse_url("https://example.com/a raw space").is_err());
        assert!(parse_url("https://exa mple.com/").is_err());
    }

    #[test]
    fn validates_methods_and_timeouts() {
        assert_eq!(validate_method("post").unwrap(), "POST");
        assert!(validate_method("TRACE").is_err());
        assert!(validate_timeout(Some(10)).is_ok());
        assert!(validate_timeout(Some(30)).is_ok());
        assert!(validate_timeout(Some(9)).is_err());
        assert!(validate_timeout(Some(31)).is_err());
    }

    #[test]
    fn validates_headers_and_rejects_hop_by_hop_controls() {
        let valid = validate_headers(&[
            header("Accept", "application/json"),
            header("Authorization", "Bearer redacted"),
        ])
        .expect("headers should validate");
        assert_eq!(valid.len(), 2);

        assert!(validate_headers(&[header("Host", "evil.example")]).is_err());
        assert!(validate_headers(&[header("Transfer-Encoding", "chunked")]).is_err());
        assert!(validate_headers(&[header("Bad Header", "x")]).is_err());
        assert!(validate_headers(&[header("X-Test", "line\nbreak")]).is_err());
    }

    #[test]
    fn builds_bounded_request_with_runtime_headers() {
        let url = parse_url("https://example.com/post").unwrap();
        let request = build_request(
            "POST",
            &url,
            &[header("Content-Type", "application/json")],
            br#"{"ok":true}"#,
        )
        .expect("request should build");
        let text = String::from_utf8(request).unwrap();
        assert!(text.starts_with("POST /post HTTP/1.1\r\n"));
        assert!(text.contains("Host: example.com\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert!(text.contains("Accept-Encoding: identity\r\n"));
        assert!(text.contains("Content-Length: 11\r\n"));
    }

    #[test]
    fn parses_response_headers() {
        let head = parse_response_head(
            b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nLocation: /items/1",
        )
        .expect("response head should parse");
        assert_eq!(head.status, 201);
        assert_eq!(head.status_text, "Created");
        assert_eq!(header_value(&head.headers, "content-type"), Some("application/json"));
    }

    #[test]
    fn decodes_chunked_response_with_bounds() {
        let initial = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n".to_vec();
        let mut empty = io::empty();
        let mut reader = BodyReader::new(&mut empty, initial);
        let (body, truncated) = read_chunked_body(&mut reader).expect("chunked body should parse");
        assert_eq!(body, b"Wikipedia");
        assert!(!truncated);
    }

    #[test]
    fn renders_binary_responses_without_raw_binary_bytes() {
        let (body, kind) = render_body(
            &[0, 159, 146, 150],
            &[header("Content-Type", "image/png")],
            true,
        );
        assert_eq!(kind, "binary");
        assert!(body.contains("binary response body"));
        assert!(body.contains("truncated"));
    }
}
