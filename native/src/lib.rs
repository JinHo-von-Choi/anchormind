use std::sync::LazyLock;

use garu_core::{AnalyzerOptions, model::Analyzer};
use napi::{Error, Result, bindgen_prelude::Buffer};
use napi_derive::napi;
use tiktoken_rs::{CoreBPE, cl100k_base};

const CL100K_ORDINARY_RANKS: u32 = 100_256;

static PIECE_ENCODER: LazyLock<std::result::Result<CoreBPE, String>> =
    LazyLock::new(|| piece_encoder().map_err(|error| error.to_string()));

fn piece_encoder() -> std::result::Result<CoreBPE, Box<dyn std::error::Error>> {
    let base = cl100k_base()?;
    let ranks = (0..CL100K_ORDINARY_RANKS)
        .map(|rank| base.decode_bytes(&[rank]).map(|bytes| (bytes, rank)))
        .collect::<std::result::Result<_, _>>()?;
    // JavaScript supplies complete pieces so whitespace and Unicode follow its regex semantics.
    Ok(CoreBPE::new(ranks, Default::default(), "(?s).+")?)
}

#[napi]
pub fn count_tokens(pieces: Vec<String>) -> Result<u32> {
    let encoder = PIECE_ENCODER.as_ref().map_err(Error::from_reason)?;
    let count: usize = pieces
        .iter()
        .map(|piece| encoder.count_ordinary(piece))
        .sum();
    u32::try_from(count).map_err(|_| Error::from_reason("Token count exceeds u32"))
}

// The Garu core revision in Cargo.toml matches this npm model version.
#[napi]
pub fn garu_version() -> &'static str {
    "0.13.1"
}

#[napi]
pub struct GaruTokenizer {
    analyzer: Analyzer,
}

#[napi]
impl GaruTokenizer {
    #[napi(constructor)]
    pub fn new(model: Buffer) -> Result<Self> {
        let analyzer = Analyzer::from_bytes_with_options(&model, AnalyzerOptions::default())
            .map_err(Error::from_reason)?;
        Ok(Self { analyzer })
    }

    #[napi]
    pub fn tokenize(&self, text: String) -> Vec<String> {
        self.analyzer.tokenize(&text)
    }
}
