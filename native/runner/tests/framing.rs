use pi_hec_runner::config::{RunnerError, MAX_FRAME_BYTES};
use pi_hec_runner::operations::{
    expect_keys, parse_broker_frame, parse_broker_request, parse_pi_client_hello, parse_strict_json, read_frame,
    write_frame,
};
use tokio::io::{duplex, AsyncWriteExt};

fn hello_json() -> Vec<u8> {
    br#"{"brokerInstanceId":"brk_1","brokerNonce":"n1","confinementRequired":true,"connectionId":"conn_1","maxFrameBytes":1048576,"protocolVersion":1}"#.to_vec()
}

#[test]
fn generated_contract_hello_round_trip_and_rejects_extra() {
    let bytes = hello_json();
    let value = parse_strict_json(&bytes).expect("canonical hello");
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["maxFrameBytes"], 1_048_576);
    assert_eq!(value["confinementRequired"], true);
    let extra = serde_json::json!({
        "brokerInstanceId": "brk_1",
        "brokerNonce": "n1",
        "confinementRequired": true,
        "connectionId": "conn_1",
        "extra": true,
        "maxFrameBytes": 1048576,
        "protocolVersion": 1
    });
    let extra_bytes = serde_json_canonicalizer::to_vec(&extra).unwrap();
    let extra_value = parse_strict_json(&extra_bytes).unwrap();
    assert!(expect_keys(
        extra_value.as_object().unwrap(),
        &[
            "protocolVersion",
            "brokerInstanceId",
            "connectionId",
            "brokerNonce",
            "maxFrameBytes",
            "confinementRequired"
        ],
        &[]
    )
    .is_err());
    let spaced = br#"{ "protocolVersion": 1 }"#;
    assert!(matches!(
        parse_strict_json(spaced),
        Err(RunnerError::CanonicalJson)
    ));
    let dup = br#"{"a":1,"a":2}"#;
    assert!(matches!(
        parse_strict_json(dup),
        Err(RunnerError::DuplicateJsonKey)
    ));
}

#[test]
fn broker_request_and_response_shapes_deserialize() {
    let request = br#"{"method":"GET_RUN_STATUS","params":{"runId":"run_01900000-0000-7000-8000-000000000001"},"requestId":"req_1"}"#;
    let value = parse_strict_json(request).expect("request");
    assert_eq!(value["method"], "GET_RUN_STATUS");
    let response = br#"{"error":{"code":"NOT_FOUND","message":"missing","retryClass":"never","schemaVersion":1},"outcome":"ERROR","requestId":"req_1"}"#;
    let parsed = parse_strict_json(response).expect("response");
    assert_eq!(parsed["outcome"], "ERROR");
    let extra = serde_json::json!({
        "method": "GET_RUN_STATUS",
        "nope": 1,
        "params": { "runId": "run_01900000-0000-7000-8000-000000000001" },
        "requestId": "req_1"
    });
    let extra_bytes = serde_json_canonicalizer::to_vec(&extra).unwrap();
    let extra_value = parse_strict_json(&extra_bytes).unwrap();
    assert!(parse_broker_request(&extra_value).is_err());
    let bad_view = serde_json::json!({
        "method": "OPEN_TRUSTED_VIEW",
        "params": {
            "runId": "run_01900000-0000-7000-8000-000000000001",
            "view": "LOGS"
        },
        "requestId": "req_1"
    });
    let bad_view_bytes = serde_json_canonicalizer::to_vec(&bad_view).unwrap();
    assert!(parse_broker_request(&parse_strict_json(&bad_view_bytes).unwrap()).is_err());
    let bad_action = serde_json::json!({
        "method": "OPEN_APPROVAL",
        "params": {
            "action": "not-an-action",
            "subjectObjectDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "requestId": "req_1"
    });
    let bad_action_bytes = serde_json_canonicalizer::to_vec(&bad_action).unwrap();
    assert!(parse_broker_request(&parse_strict_json(&bad_action_bytes).unwrap()).is_err());
    let provide = serde_json::json!({
        "method": "PROVIDE_INPUT",
        "params": {
            "answer": "yes",
            "expectedStateVersion": 3,
            "questionId": "q1",
            "runId": "run_01900000-0000-7000-8000-000000000001"
        },
        "requestId": "req_1"
    });
    let provide_bytes = serde_json_canonicalizer::to_vec(&provide).unwrap();
    let parsed = parse_broker_request(&parse_strict_json(&provide_bytes).unwrap()).unwrap();
    assert_eq!(parsed.1, "PROVIDE_INPUT");
    assert_eq!(parsed.2["expectedStateVersion"], 3);
}

#[test]
fn pi_client_hello_requires_exact_keys() {
    let ok = serde_json::json!({
        "claimedProcessCreationTime": "2026-08-27T00:00:00.000Z",
        "claimedProcessId": 12,
        "clientInstanceId": "cli_1",
        "clientNonce": "n",
        "connectionId": "conn_1",
        "protocolVersion": 1
    });
    let bytes = serde_json_canonicalizer::to_vec(&ok).unwrap();
    let value = parse_strict_json(&bytes).unwrap();
    let hello = parse_pi_client_hello(&value).unwrap();
    assert_eq!(hello.claimed_process_id, 12);
    let extra = serde_json::json!({
        "claimedProcessCreationTime": "2026-08-27T00:00:00.000Z",
        "claimedProcessId": 12,
        "clientInstanceId": "cli_1",
        "clientNonce": "n",
        "connectionId": "conn_1",
        "extra": 1,
        "protocolVersion": 1
    });
    let bytes = serde_json_canonicalizer::to_vec(&extra).unwrap();
    let value = parse_strict_json(&bytes).unwrap();
    assert!(parse_pi_client_hello(&value).is_err());
}

#[tokio::test]
async fn framing_rejects_oversize_zero_and_truncation() {
    let (mut a, mut b) = duplex(64);
    assert!(matches!(
        write_frame(&mut a, &[]).await,
        Err(RunnerError::ZeroLengthFrame)
    ));
    let huge = vec![b'x'; (MAX_FRAME_BYTES as usize) + 1];
    assert!(matches!(
        write_frame(&mut a, &huge).await,
        Err(RunnerError::OversizeFrame)
    ));
    a.write_all(&1u32.to_be_bytes()).await.unwrap();
    drop(a);
    let err = read_frame(&mut b).await.unwrap_err();
    assert!(matches!(err, RunnerError::Io(_)));
}

#[tokio::test]
async fn sequence_and_non_canonical_body_are_rejected() {
    let (mut a, mut b) = duplex(4096);
    let body = hello_json();
    write_frame(&mut a, &body).await.unwrap();
    let got = read_frame(&mut b).await.unwrap();
    assert_eq!(got, body);
    let spaced = b"{ \"protocolVersion\": 1 }";
    write_frame(&mut a, spaced).await.unwrap();
    let frame = read_frame(&mut b).await.unwrap();
    assert!(matches!(
        parse_strict_json(&frame),
        Err(RunnerError::CanonicalJson)
    ));
}

#[test]
fn broker_frame_sequence_must_be_positive() {
    let frame = serde_json::json!({
        "body": {
            "method": "RESUME_RUN",
            "params": { "runId": "run_01900000-0000-7000-8000-000000000001" },
            "requestId": "req_1"
        },
        "connectionId": "conn_1",
        "protocolVersion": 1,
        "sequence": 0
    });
    let bytes = serde_json_canonicalizer::to_vec(&frame).unwrap();
    let value = parse_strict_json(&bytes).unwrap();
    assert!(matches!(
        parse_broker_frame(&value),
        Err(RunnerError::SequenceGap)
    ));
}
